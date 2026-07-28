/**
 * PUBLIC API — the signal contract.
 *
 * Sources produce a `Signal`. Renderers consume it. Neither knows the other exists.
 * A renderer must NEVER branch on whether the microphone or Spotify is connected:
 * when a source is absent the bus synthesises a plausible substitute, so every
 * field below is always populated with something usable.
 *
 * Changing anything in this file is a breaking change for every visual mode.
 * See CLAUDE.md.
 */

/** Non-linear sRGB, each component 0..1. */
export type RGB = readonly [number, number, number]

export interface Palette {
  id: string
  name: string
  /**
   * Colour stops ordered by luminance, darkest first. Always at least 2 entries,
   * normally 8. This is the primary thing modes should sample from — use
   * `sampleRamp()` rather than indexing, so palettes of different lengths work.
   */
  ramp: RGB[]
  /** Deep background. Usually darker than ramp[0]; safe to clear the screen with. */
  background: RGB
  /** The highest-chroma stop. For highlights, sparks, and accents. */
  accent: RGB
  /** Mean HSL saturation across the source colours, 0..1. */
  meanSaturation: number
  /** Circular variance of hue, 0..1. 0 = monochrome, 1 = hues all over the wheel. */
  hueVariance: number
  /** 8-bucket normalised luminance histogram, sums to 1. Dark buckets first. */
  luminanceHistogram: number[]
}

export interface TrackInfo {
  id: string
  title: string
  artist: string
  album: string
  /** Remote album art URL, or null. Loaded with crossOrigin="anonymous". */
  artworkUrl: string | null
  durationMs: number
}

/**
 * Slow-moving aesthetic descriptors, each 0..1. Blended from the palette
 * (when Spotify supplies one) and the live audio. These drift over seconds,
 * never per-frame — modes can safely use them to pick regimes, not to animate.
 */
export interface Mood {
  /** How much is going on. Drives rates, particle counts, turbulence. */
  energy: number
  /** 0 = cold/blue/sparse, 1 = warm/red/dense. From palette hue + spectral tilt. */
  warmth: number
  /** Tonal spread. Low = flat and foggy, high = hard edges and deep blacks. */
  contrast: number
  /** Visual busyness. Low = a few large forms, high = many small ones. */
  density: number
}

export interface Signal {
  /** Seconds since app start. Monotonic, never resets. */
  t: number
  /** Seconds since the previous frame. Clamped to a sane range; never 0 or huge. */
  dt: number
  /**
   * N log-spaced energy bands, each 0..1, smoothed and rolling-normalised so a
   * quiet room and a loud room look the same. Index 0 is the lowest frequency.
   * Length is stable for the lifetime of the app (see BAND_COUNT).
   */
  bands: Float32Array
  /** Overall normalised loudness, 0..1. Decays cleanly to 0 in silence. */
  level: number
  /** Spikes to 1 on a detected onset, then decays. 0..1. */
  onset: number
  /** 0..1 sawtooth synced to the estimated tempo. Free-runs when tempo is unknown. */
  beatPhase: number
  /** Estimated tempo, or null while the estimator is not confident. */
  bpm: number | null
  /** ALWAYS present, never null. Crossfaded on track change. */
  palette: Palette
  /** Null unless Spotify is connected and playing. */
  track: TrackInfo | null
  /** 0..1 through the current track, or null. Interpolated between polls. */
  playhead: number | null
  mood: Mood
}

/** Number of log-spaced bands in `Signal.bands`. Fixed for the app's lifetime. */
export const BAND_COUNT = 32

/**
 * Sample a palette ramp at x in 0..1, linearly interpolating between stops.
 * Use this instead of `palette.ramp[i]` so modes survive palettes of any length.
 */
export function sampleRamp(palette: Palette, x: number): RGB {
  const ramp = palette.ramp
  if (ramp.length === 0) return [0, 0, 0]
  if (ramp.length === 1) return ramp[0]
  const clamped = x < 0 ? 0 : x > 1 ? 1 : x
  const pos = clamped * (ramp.length - 1)
  const i = Math.min(Math.floor(pos), ramp.length - 2)
  const f = pos - i
  const a = ramp[i]
  const b = ramp[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}
