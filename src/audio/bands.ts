/**
 * FFT bin -> log-spaced band mapping.
 *
 * Linear bin spacing is the classic mistake: at 48 kHz with fftSize 2048 each
 * bin is 23.4 Hz, so a linear split across 32 bands gives the bottom band
 * 30-750 Hz (where nearly all musical energy lives) and the top band
 * 15-16 kHz (where essentially nothing does). Log spacing matches how pitch
 * and loudness actually work.
 *
 * Pure functions over Float32Array so all of this is testable without a mic.
 */

/** Lowest frequency we care about. Below this is mostly rumble and DC offset. */
export const F_MIN = 30
/** Highest. Above this is air and hiss; it eats bands and shows nothing. */
export const F_MAX = 16000

/**
 * Bin index boundaries for `bandCount` log-spaced bands.
 *
 * Returns `bandCount + 1` entries, so band i covers bins [edges[i], edges[i+1]).
 * Every band is guaranteed at least one bin: at the bottom of the range the
 * ideal log edges land inside a single bin, and without this clamp the first
 * several bands would be empty and read as permanent silence.
 */
export function computeBandEdges(
  bandCount: number,
  fftSize: number,
  sampleRate: number,
  fMin = F_MIN,
  fMax = F_MAX,
): Int32Array {
  const binCount = fftSize / 2
  const hzPerBin = sampleRate / fftSize
  const nyquistBin = binCount - 1

  const top = Math.min(fMax, sampleRate / 2)
  const logMin = Math.log(fMin)
  const logMax = Math.log(top)

  const edges = new Int32Array(bandCount + 1)
  let previous = Math.max(1, Math.floor(fMin / hzPerBin)) // skip bin 0 (DC)
  edges[0] = previous

  for (let i = 1; i <= bandCount; i++) {
    const hz = Math.exp(logMin + ((logMax - logMin) * i) / bandCount)
    let bin = Math.round(hz / hzPerBin)
    // Monotonic, at least one bin wide, and never past Nyquist.
    if (bin <= previous) bin = previous + 1
    if (bin > nyquistBin) bin = nyquistBin
    edges[i] = bin
    previous = bin
  }

  // If we ran out of bins at the top (very low sample rate / very high bandCount),
  // walk backwards to keep every band non-empty.
  for (let i = bandCount; i > 0; i--) {
    if (edges[i] <= edges[i - 1]) edges[i - 1] = edges[i] - 1
  }
  return edges
}

/**
 * Average the linear magnitude spectrum into bands.
 *
 * `spectrum` is linear amplitude (not dB) — run `decibelsToLinear` first if you
 * are coming from `AnalyserNode.getFloatFrequencyData`.
 */
export function foldToBands(
  spectrum: Float32Array,
  edges: Int32Array,
  out: Float32Array,
): Float32Array {
  const bandCount = out.length
  for (let i = 0; i < bandCount; i++) {
    const start = edges[i]
    const end = edges[i + 1]
    let sum = 0
    for (let b = start; b < end; b++) sum += spectrum[b]
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

/**
 * Convert dB (AnalyserNode's native output, typically -100..0) to linear
 * amplitude 0..1. Values at or below `floorDb` become exactly 0 so silence is
 * genuinely zero rather than a tiny number that the normaliser can amplify.
 */
export function decibelsToLinear(
  db: Float32Array,
  out: Float32Array,
  floorDb = -100,
): Float32Array {
  for (let i = 0; i < db.length; i++) {
    const value = db[i]
    out[i] = value <= floorDb || !Number.isFinite(value) ? 0 : Math.pow(10, value / 20)
  }
  return out
}

/**
 * Loudness-ish weighting: human hearing rolls off hard at the bottom, so raw
 * band energy makes every visual bass-dominated. A gentle tilt across the band
 * range evens it out without the complexity of a real A-weighting curve.
 */
export function applyTilt(bands: Float32Array, strength = 0.6): Float32Array {
  const n = bands.length
  for (let i = 0; i < n; i++) {
    const x = n > 1 ? i / (n - 1) : 0
    bands[i] *= 1 + strength * x * 2
  }
  return bands
}

/**
 * Spectral centroid in 0..1 across the band range. Low = bass-heavy (reads as
 * warm), high = bright. Feeds `mood.warmth`.
 */
export function spectralCentroid(bands: Float32Array): number {
  let weighted = 0
  let total = 0
  for (let i = 0; i < bands.length; i++) {
    weighted += bands[i] * i
    total += bands[i]
  }
  if (total <= 1e-6) return 0.5 // silence: sit in the middle rather than snapping to 0
  return weighted / total / Math.max(1, bands.length - 1)
}
