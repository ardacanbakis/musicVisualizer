/**
 * The microphone source — the real DSP chain.
 *
 * Signal path, in order, and why each stage is there:
 *
 *   getUserMedia          all three processing flags OFF. Echo cancellation,
 *                         noise suppression and AGC are tuned for speech and
 *                         each one destroys music: they duck sustained tones,
 *                         gate reverb tails, and pump the level.
 *   AnalyserNode          fftSize 2048, smoothingTimeConstant 0. The built-in
 *                         smoothing is a symmetric EMA — we do our own
 *                         asymmetric version downstream, and stacking the two
 *                         just adds latency.
 *   dB -> linear          AnalyserNode reports dB; everything after wants
 *                         amplitude.
 *   fold to log bands     see bands.ts.
 *   noise gate            hysteresis, so a room at the threshold doesn't flicker.
 *   envelope follower     fast attack, slow release.
 *   rolling normalise     per band, with a floor.
 *   spectral flux         computed on the full linear spectrum, before folding,
 *                         because folding to 32 bands throws away exactly the
 *                         fine detail that makes a note onset detectable.
 *   onset -> tempo -> phase
 */
import {
  computeBandEdges,
  decibelsToLinear,
  foldToBands,
  applyTilt,
} from '../../audio/bands'
import { EnvelopeFollower, followScalar } from '../../audio/envelope'
import { NoiseGate, RollingNormaliser, normaliseScalar } from '../../audio/normalise'
import { OnsetDetector, spectralFlux } from '../../audio/onset'
import { BeatClock, TempoEstimator } from '../../audio/tempo'
import { BAND_COUNT } from '../types'
import type { AudioDebug, AudioFrame, AudioSource } from './types'

export const FFT_SIZE = 2048

export class MicrophoneSource implements AudioSource {
  readonly id = 'microphone'
  readonly label = 'Microphone'

  readonly debug: AudioDebug = {
    flux: 0,
    threshold: 0,
    gate: 0,
    tempoConfidence: 0,
    rawLevel: 0,
  }

  // Explicit <ArrayBuffer>: a bare `Float32Array` annotation widens to
  // ArrayBufferLike under TS 5.7+, which getFloatFrequencyData rejects.
  private decibels: Float32Array<ArrayBuffer>
  private spectrum: Float32Array<ArrayBuffer>
  private previousSpectrum: Float32Array<ArrayBuffer>
  private rawBands: Float32Array<ArrayBuffer>
  private edges: Int32Array

  private envelope: EnvelopeFollower
  private normaliser: RollingNormaliser
  private gate = new NoiseGate()
  private onsetDetector = new OnsetDetector()
  private tempo = new TempoEstimator()
  private clock = new BeatClock()

  private levelSmoothed = 0
  private levelPeak = 0
  private onsetValue = 0
  private disposed = false

  private constructor(
    private context: AudioContext,
    private analyser: AnalyserNode,
    private stream: MediaStream,
    private node: MediaStreamAudioSourceNode,
    bandCount: number,
  ) {
    const bins = analyser.frequencyBinCount
    this.decibels = new Float32Array(bins)
    this.spectrum = new Float32Array(bins)
    this.previousSpectrum = new Float32Array(bins)
    this.rawBands = new Float32Array(bandCount)
    this.edges = computeBandEdges(bandCount, FFT_SIZE, context.sampleRate)
    this.envelope = new EnvelopeFollower(bandCount)
    this.normaliser = new RollingNormaliser(bandCount)
  }

  /**
   * Prompts for microphone access. Rejects if the user declines or there is no
   * input device — callers are expected to fall back to the synthetic source.
   */
  static async open(bandCount: number = BAND_COUNT): Promise<MicrophoneSource> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    })

    const context = new AudioContext()
    // Autoplay policy: the context starts suspended unless this was triggered
    // by a user gesture. Resuming is a no-op when it is already running.
    if (context.state === 'suspended') await context.resume()

    const analyser = context.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0
    analyser.minDecibels = -100
    analyser.maxDecibels = -10

    const node = context.createMediaStreamSource(stream)
    node.connect(analyser)
    // Deliberately NOT connected to context.destination — routing the mic to
    // the speakers is a feedback loop, and a painful one on a TV.

    return new MicrophoneSource(context, analyser, stream, node, bandCount)
  }

  poll(dt: number, t: number, out: AudioFrame): void {
    if (this.disposed) return

    this.analyser.getFloatFrequencyData(this.decibels)
    decibelsToLinear(this.decibels, this.spectrum, this.analyser.minDecibels)

    // --- flux first, on the full-resolution spectrum ---
    const flux = spectralFlux(this.spectrum, this.previousSpectrum)
    this.previousSpectrum.set(this.spectrum)

    // --- bands ---
    foldToBands(this.spectrum, this.edges, this.rawBands)

    let sum = 0
    for (let i = 0; i < this.rawBands.length; i++) sum += this.rawBands[i]
    const rawLevel = sum / this.rawBands.length

    const gateGain = this.gate.process(rawLevel, dt)
    if (gateGain < 1) {
      for (let i = 0; i < this.rawBands.length; i++) this.rawBands[i] *= gateGain
    }

    applyTilt(this.rawBands)

    const smoothed = this.envelope.process(this.rawBands, dt)
    const normalised = this.normaliser.process(smoothed, dt)
    out.bands.set(normalised)

    // --- level ---
    const gatedLevel = rawLevel * gateGain
    this.levelSmoothed = followScalar(this.levelSmoothed, gatedLevel, dt, 0.03, 0.35)
    const scaled = normaliseScalar(this.levelSmoothed, this.levelPeak, dt)
    this.levelPeak = scaled.peak
    out.level = scaled.value

    // --- onsets ---
    // Gate the flux too: in a silent room the flux ratio is dominated by
    // whatever noise the preamp is making, and it will happily find "onsets".
    const gatedFlux = flux * gateGain
    const onset = this.onsetDetector.process(gatedFlux, t)

    this.onsetValue *= Math.exp(-dt / 0.18)
    if (onset.detected) {
      this.onsetValue = Math.max(this.onsetValue, onset.strength)
      this.tempo.addOnset(t, onset.strength)
      this.clock.nudge(onset.strength)
    }
    if (this.onsetValue < 1e-4) this.onsetValue = 0
    out.onset = this.onsetValue

    // --- tempo ---
    this.tempo.decay(dt)
    const estimate = this.tempo.estimate()
    this.clock.setBpm(estimate.bpm)
    out.bpm = estimate.bpm
    out.beatPhase = this.clock.advance(dt)

    // --- debug ---
    this.debug.flux = gatedFlux
    this.debug.threshold = onset.threshold
    this.debug.gate = gateGain
    this.debug.tempoConfidence = estimate.confidence
    this.debug.rawLevel = rawLevel
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.node.disconnect()
      this.analyser.disconnect()
      // Stopping every track is what actually turns off the browser's recording
      // indicator. Closing the context alone leaves it lit.
      for (const track of this.stream.getTracks()) track.stop()
      void this.context.close()
    } catch {
      // Disposal must never throw; there is nothing useful to do about it.
    }
  }
}
