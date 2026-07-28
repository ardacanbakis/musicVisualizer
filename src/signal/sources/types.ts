/**
 * An audio source fills in the rhythmic half of the Signal. The bus owns the
 * palette/track half and stitches the two together.
 *
 * Sources must never throw from `poll()` — the render loop calls it every
 * frame and a wall display cannot recover from an exception 6 hours in.
 */
import { WAVEFORM_SIZE } from '../types'
import type { BAND_COUNT } from '../types'

/** Written in place each frame to avoid allocating 60 times a second. */
export interface AudioFrame {
  /** Length is always BAND_COUNT. Values 0..1. */
  bands: Float32Array
  /** Length is always WAVEFORM_SIZE. Values -1..1, already gated. */
  waveform: Float32Array
  level: number
  onset: number
  beatPhase: number
  bpm: number | null
}

/** Extra internals for the debug overlay only. No mode may read this. */
export interface AudioDebug {
  /** Raw spectral flux this frame. */
  flux: number
  /** Adaptive threshold flux was compared against. */
  threshold: number
  /** Noise gate gain, 0..1. */
  gate: number
  /** Tempo estimator confidence, 0..1. */
  tempoConfidence: number
  /** Pre-normalisation loudness, for spotting a dead or clipping input. */
  rawLevel: number
}

export interface AudioSource {
  /** Stable id: 'synthetic' | 'microphone'. */
  readonly id: string
  readonly label: string
  /** Fill `out` with this frame's values. Must not throw. */
  poll(dt: number, t: number, out: AudioFrame): void
  /** Release the microphone, close the AudioContext, etc. */
  dispose(): void
  /** Optional debug internals. */
  readonly debug?: AudioDebug
}

export function createAudioFrame(bandCount: typeof BAND_COUNT | number): AudioFrame {
  return {
    bands: new Float32Array(bandCount),
    waveform: new Float32Array(WAVEFORM_SIZE),
    level: 0,
    onset: 0,
    beatPhase: 0,
    bpm: null,
  }
}
