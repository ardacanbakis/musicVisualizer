/**
 * The synthetic source — layered LFOs standing in for audio that isn't there.
 *
 * This is the app's default state, before any permission prompt, and the
 * fallback whenever the microphone is unavailable or revoked. It exists so no
 * renderer ever has to ask whether a mic is connected: the contract is
 * satisfied unconditionally.
 *
 * Design notes, because "fake some sine waves" produces something obviously
 * fake within about ten seconds of watching it:
 *
 *  - Every oscillator pair uses an irrational-ish frequency ratio, so the
 *    combined pattern never returns to its starting state. Round ratios give a
 *    visible loop, and a loop on a wall display is the thing people notice.
 *  - Motion is layered across three timescales: a ~50 s swell, a few-second
 *    drift, and the beat. Real music has all three; only one reads as a screen
 *    saver.
 *  - The beat pulse is weighted towards the low bands, and onsets alternate
 *    strong/weak, because that is what a kick-snare pattern does to a spectrum.
 */
import { BAND_COUNT } from '../types'
import { BeatClock } from '../../audio/tempo'
import type { AudioFrame, AudioSource } from './types'

/** Deliberately unhurried. This is the "quiet room" default. */
const DEFAULT_BPM = 84

export class SyntheticSource implements AudioSource {
  readonly id = 'synthetic'
  readonly label = 'Synthetic'

  private clock: BeatClock
  private previousPhase = 0
  private onsetValue = 0
  private beatIndex = 0
  private levelValue = 0

  constructor(private bpm = DEFAULT_BPM) {
    this.clock = new BeatClock(bpm)
  }

  poll(dt: number, t: number, out: AudioFrame): void {
    const phase = this.clock.advance(dt)

    // Phase wrapped => a beat happened.
    if (phase < this.previousPhase) {
      this.beatIndex++
      // Downbeats hit harder; the third beat of the bar is a ghost note.
      const pattern = [1.0, 0.45, 0.75, 0.5]
      const strength = pattern[this.beatIndex % pattern.length]
      this.onsetValue = Math.max(this.onsetValue, strength)
    }
    this.previousPhase = phase

    // ~0.22 s decay, matching the envelope release used on real audio.
    this.onsetValue *= Math.exp(-dt / 0.22)
    if (this.onsetValue < 1e-4) this.onsetValue = 0

    // Beat pulse: a short exponential bloom after each beat.
    const sincePulse = phase * (60 / this.bpm)
    const pulse = Math.exp(-sincePulse * 7)

    // Long swell across ~50 s, so the whole picture breathes.
    const swell = 0.55 + 0.35 * Math.sin(t * 0.1257) + 0.1 * Math.sin(t * 0.0431 + 2.1)

    const bands = out.bands
    const n = bands.length
    let sum = 0
    for (let i = 0; i < n; i++) {
      const x = n > 1 ? i / (n - 1) : 0

      // Two travelling waves crossing the spectrum at unrelated speeds.
      const waveA = 0.5 + 0.5 * Math.sin(t * 0.317 + x * 5.7)
      const waveB = 0.5 + 0.5 * Math.sin(-t * 0.191 + x * 11.3 + 1.7)
      const waveC = 0.5 + 0.5 * Math.sin(t * 0.0734 + x * 2.3 + 4.2)

      // Spectral tilt: real music has more energy low down. Deliberately
      // gentle — a realistic tilt leaves the top half of the spectrum near
      // zero, and a mode reading those bands then has a dead region on screen
      // for as long as nothing is playing. Half the point of this source is
      // that the whole picture stays alive.
      const tilt = Math.pow(1 - x, 0.85) * 0.45 + 0.55

      // Bass follows the beat; treble shimmers independently of it.
      const beatWeight = Math.pow(1 - x, 1.6)

      let value = (0.35 * waveA + 0.35 * waveB + 0.3 * waveC) * tilt
      value *= swell
      value += pulse * beatWeight * 0.55 * swell
      // A touch of high-frequency sparkle so the top of the spectrum isn't dead.
      value += Math.max(0, waveB - 0.82) * x * 0.5

      const clamped = value < 0 ? 0 : value > 1 ? 1 : value
      bands[i] = clamped
      sum += clamped
    }

    // Level tracks the mean but is deliberately smoother than the bands.
    const target = Math.min(1, (sum / n) * 1.8)
    this.levelValue += (target - this.levelValue) * Math.min(1, dt * 4)

    out.level = this.levelValue
    out.onset = this.onsetValue
    out.beatPhase = phase
    // A synthetic tempo is a known quantity, not an estimate — but reporting it
    // would let a mode display "84 BPM" for a silent room, which is a lie.
    out.bpm = null
  }

  dispose(): void {
    // Nothing to release.
  }
}

export function createSyntheticSource(bpm?: number): AudioSource {
  return new SyntheticSource(bpm)
}

/** Convenience for tests. */
export const SYNTHETIC_BAND_COUNT = BAND_COUNT
