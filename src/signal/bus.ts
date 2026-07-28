/**
 * The signal bus.
 *
 * This is the piece the whole app is built around. Sources push into it,
 * renderers pull a fully-populated `Signal` out of it, and neither side knows
 * the other exists. The bus's real job is to make absence invisible: when there
 * is no microphone it runs the synthetic source, when there is no Spotify it
 * serves a built-in palette, and either way `update()` returns the same shape
 * with every field filled in. That is what lets a mode be written without a
 * single `if (micConnected)`.
 */
import { followScalar } from '../audio/envelope'
import { spectralCentroid } from '../audio/bands'
import { mixPalette } from './color'
import { DEFAULT_PALETTE } from './palettes'
import { createSyntheticSource } from './sources/synthetic'
import { createAudioFrame } from './sources/types'
import type { AudioDebug, AudioFrame, AudioSource } from './sources/types'
import { BAND_COUNT } from './types'
import type { Mood, Palette, Signal, TrackInfo } from './types'

/** Below this the frame is treated as a duplicate; above it, as a stall. */
const MIN_DT = 1 / 480
const MAX_DT = 0.1

/** Seconds to crossfade the palette on a track change. Never hard-cut colour. */
const PALETTE_FADE_SECONDS = 2

/** Mood fields drift over seconds, never per-frame. */
const MOOD_TAU = 2.5

export class SignalBus {
  private startTime = 0
  private lastTime = 0
  private started = false

  private source: AudioSource
  private syntheticSource: AudioSource
  private frame: AudioFrame

  private paletteFrom: Palette
  private paletteTo: Palette
  private paletteMix = 1
  private palette: Palette

  private track: TrackInfo | null = null
  private playhead: number | null = null

  private mood: Mood = { energy: 0.3, warmth: 0.5, contrast: 0.5, density: 0.3 }
  private onsetAverage = 0

  private signal: Signal

  constructor(bandCount: number = BAND_COUNT) {
    this.syntheticSource = createSyntheticSource()
    this.source = this.syntheticSource
    this.frame = createAudioFrame(bandCount)

    this.palette = DEFAULT_PALETTE
    this.paletteFrom = DEFAULT_PALETTE
    this.paletteTo = DEFAULT_PALETTE

    // One object, mutated in place. A 60 Hz allocation of a Signal plus a
    // Float32Array is exactly the kind of thing that shows up as GC stutter
    // three hours into a session.
    this.signal = {
      t: 0,
      dt: 0,
      bands: this.frame.bands,
      waveform: this.frame.waveform,
      level: 0,
      onset: 0,
      beatPhase: 0,
      bpm: null,
      palette: this.palette,
      track: null,
      playhead: null,
      mood: this.mood,
    }
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  /**
   * Swap in a real audio source, or pass null to fall back to the synthetic one.
   * Disposing the outgoing source is the bus's responsibility, except for the
   * synthetic source which it owns for its whole lifetime.
   */
  setAudioSource(source: AudioSource | null): void {
    const next = source ?? this.syntheticSource
    if (next === this.source) return
    if (this.source !== this.syntheticSource) this.source.dispose()
    this.source = next
  }

  get sourceId(): string {
    return this.source.id
  }

  get sourceLabel(): string {
    return this.source.label
  }

  get audioDebug(): AudioDebug | null {
    return this.source.debug ?? null
  }

  // -------------------------------------------------------------------------
  // Palette / track (driven by Spotify in phase 5, by the user before that)
  // -------------------------------------------------------------------------

  /** Crossfade to a new palette over ~2 s. Instant only on first set. */
  setPalette(palette: Palette, immediate = false): void {
    if (palette.id === this.paletteTo.id && !immediate) return
    if (immediate) {
      this.palette = palette
      this.paletteFrom = palette
      this.paletteTo = palette
      this.paletteMix = 1
      return
    }
    // Fade from wherever we currently are, not from the previous target — a
    // track change mid-fade should not jump backwards.
    this.paletteFrom = this.palette
    this.paletteTo = palette
    this.paletteMix = 0
  }

  setTrack(track: TrackInfo | null): void {
    this.track = track
  }

  setPlayhead(playhead: number | null): void {
    this.playhead = playhead
  }

  /** The interpolated playhead, for UI that wants it outside the render loop. */
  get currentPlayhead(): number | null {
    return this.playhead
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * @param nowMs a `performance.now()`-style timestamp in milliseconds.
   */
  update(nowMs: number): Signal {
    const now = nowMs / 1000
    if (!this.started) {
      this.started = true
      this.startTime = now
      this.lastTime = now
    }

    const t = now - this.startTime
    // Clamping matters: coming back from a hidden tab hands us a dt of several
    // seconds, which would fast-forward every envelope and flash the screen.
    let dt = now - this.lastTime
    this.lastTime = now
    if (!Number.isFinite(dt) || dt < MIN_DT) dt = MIN_DT
    if (dt > MAX_DT) dt = MAX_DT

    try {
      this.source.poll(dt, t, this.frame)
    } catch {
      // A source that throws is a source we stop trusting. Falling back keeps
      // the wall display alive rather than freezing on the last good frame.
      this.setAudioSource(null)
      this.source.poll(dt, t, this.frame)
    }

    this.advancePalette(dt)
    this.updateMood(dt)

    const signal = this.signal
    signal.t = t
    signal.dt = dt
    signal.bands = this.frame.bands
    signal.waveform = this.frame.waveform
    signal.level = this.frame.level
    signal.onset = this.frame.onset
    signal.beatPhase = this.frame.beatPhase
    signal.bpm = this.frame.bpm
    signal.palette = this.palette
    signal.track = this.track
    signal.playhead = this.playhead
    signal.mood = this.mood
    return signal
  }

  private advancePalette(dt: number): void {
    if (this.paletteMix >= 1) return
    this.paletteMix = Math.min(1, this.paletteMix + dt / PALETTE_FADE_SECONDS)
    // Smoothstep, so the fade eases at both ends instead of starting and
    // stopping abruptly.
    const x = this.paletteMix
    const eased = x * x * (3 - 2 * x)
    this.palette =
      this.paletteMix >= 1 ? this.paletteTo : mixPalette(this.paletteFrom, this.paletteTo, eased)
  }

  /**
   * Mood blends the live audio with the palette's own character. The palette
   * contribution is what stops a silent room from reading as moodless: the
   * colours still say something about warmth and contrast even when nothing is
   * playing.
   */
  private updateMood(dt: number): void {
    const bands = this.frame.bands
    const palette = this.palette

    // Energy: loudness, with onsets counting for something so a percussive
    // quiet track isn't rated as low-energy as an ambient one.
    this.onsetAverage = followScalar(this.onsetAverage, this.frame.onset, dt, 0.5, 4)
    const energyTarget = Math.min(1, this.frame.level * 0.75 + this.onsetAverage * 0.6)

    // Warmth: bass-heavy audio reads warm, and so does a red/orange palette.
    const centroid = spectralCentroid(bands)
    const paletteHueWarmth = paletteWarmth(palette)
    const warmthTarget = (1 - centroid) * 0.45 + paletteHueWarmth * 0.55

    // Contrast: how peaky the spectrum is, plus how spread the palette's
    // luminance histogram is.
    let mean = 0
    for (let i = 0; i < bands.length; i++) mean += bands[i]
    mean /= Math.max(1, bands.length)
    let variance = 0
    for (let i = 0; i < bands.length; i++) {
      const d = bands[i] - mean
      variance += d * d
    }
    variance /= Math.max(1, bands.length)
    const spread = histogramSpread(palette.luminanceHistogram)
    const contrastTarget = Math.min(1, Math.sqrt(variance) * 2.2 * 0.6 + spread * 0.4)

    // Density: how many bands are actually alive, plus the onset rate.
    let active = 0
    for (let i = 0; i < bands.length; i++) if (bands[i] > 0.25) active++
    const densityTarget = Math.min(
      1,
      (active / Math.max(1, bands.length)) * 0.7 + this.onsetAverage * 0.5,
    )

    const mood = this.mood
    mood.energy = followScalar(mood.energy, energyTarget, dt, MOOD_TAU, MOOD_TAU)
    mood.warmth = followScalar(mood.warmth, warmthTarget, dt, MOOD_TAU, MOOD_TAU)
    mood.contrast = followScalar(mood.contrast, contrastTarget, dt, MOOD_TAU, MOOD_TAU)
    mood.density = followScalar(mood.density, densityTarget, dt, MOOD_TAU, MOOD_TAU)
  }

  dispose(): void {
    if (this.source !== this.syntheticSource) this.source.dispose()
    this.syntheticSource.dispose()
  }
}

/** Red/orange -> 1, cyan/blue -> 0, weighted by how saturated the palette is. */
function paletteWarmth(palette: Palette): number {
  let x = 0
  let y = 0
  let weight = 0
  for (const color of palette.ramp) {
    const max = Math.max(color[0], color[1], color[2])
    const min = Math.min(color[0], color[1], color[2])
    const chroma = max - min
    if (chroma < 1e-4) continue
    let hue: number
    if (max === color[0]) hue = ((color[1] - color[2]) / chroma + 6) % 6
    else if (max === color[1]) hue = (color[2] - color[0]) / chroma + 2
    else hue = (color[0] - color[1]) / chroma + 4
    const angle = (hue / 6) * Math.PI * 2
    x += Math.cos(angle) * chroma
    y += Math.sin(angle) * chroma
    weight += chroma
  }
  if (weight <= 1e-6) return 0.5 // greyscale palette: neither warm nor cold
  const meanAngle = Math.atan2(y / weight, x / weight)
  return 0.5 + 0.5 * Math.cos(meanAngle)
}

/** Normalised entropy-ish spread of a histogram. Flat = 1, single spike = 0. */
function histogramSpread(histogram: number[]): number {
  let entropy = 0
  for (const p of histogram) if (p > 0) entropy -= p * Math.log(p)
  const maximum = Math.log(Math.max(2, histogram.length))
  // Inverted: a *concentrated* histogram means high tonal contrast.
  return 1 - Math.min(1, entropy / maximum)
}
