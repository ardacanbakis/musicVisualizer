/**
 * Onset detection by spectral flux against an adaptive median threshold.
 *
 * Spectral flux = the sum of positive bin-to-bin changes between consecutive
 * frames. Only *increases* count: energy appearing is a note starting, energy
 * disappearing is a note ending, and we only want the former.
 *
 * The threshold has to be adaptive. A fixed one is tuned for exactly one genre
 * at exactly one volume — it fires constantly on dense music and never on
 * sparse music. The median of the last ~1 second of flux tracks the current
 * texture, and the median specifically (rather than the mean) is what makes it
 * robust: a big onset drags a mean upwards and masks the onsets right after it,
 * while the median barely moves.
 *
 * The refractory period stops a single drum hit, whose attack spans several
 * frames, from registering as four onsets in a row.
 */

/**
 * Sum of positive bin-to-bin deltas between two frames, divided by the total
 * energy of the current frame.
 *
 * That divisor is the difference between something that works across rooms and
 * something that needs a sensitivity slider. Raw flux scales with volume, so
 * the absolute floors below would have to be retuned every time the speakers
 * move. Dividing by current energy makes flux a *proportion* — "how much of
 * what I'm hearing is new" — which is bounded in 0..1, is naturally 0 in
 * silence, and means the same thing at any volume.
 */
export function spectralFlux(current: Float32Array, previous: Float32Array): number {
  let rising = 0
  let total = 0
  const n = Math.min(current.length, previous.length)
  for (let i = 0; i < n; i++) {
    const value = current[i]
    total += value
    const delta = value - previous[i]
    if (delta > 0) rising += delta
  }
  if (total <= 1e-9) return 0
  return rising / total
}

/** Median of the first `count` entries of `values`. Does not mutate the input. */
export function median(values: Float32Array, count = values.length): number {
  if (count <= 0) return 0
  const copy = values.slice(0, count)
  copy.sort()
  const mid = count >> 1
  return count % 2 === 1 ? copy[mid] : (copy[mid - 1] + copy[mid]) * 0.5
}

export interface OnsetOptions {
  /** Seconds of flux history the median is taken over. */
  windowSeconds?: number
  /** Frames per second assumed when sizing the history ring. */
  expectedFps?: number
  /** Threshold = median * multiplier + delta. */
  multiplier?: number
  delta?: number
  /** Minimum seconds between onsets. */
  refractorySeconds?: number
  /** Absolute flux floor; below this we never fire, whatever the median says. */
  minimumFlux?: number
}

export interface OnsetResult {
  /** True on the frame an onset is detected. */
  detected: boolean
  /** 0..1 confidence-ish strength of this onset. 0 when not detected. */
  strength: number
  /** Raw flux this frame — for the debug overlay. */
  flux: number
  /** The threshold flux was compared against — for the debug overlay. */
  threshold: number
}

export class OnsetDetector {
  private history: Float32Array
  private historyCount = 0
  private writeIndex = 0
  private lastOnsetTime = -Infinity
  private multiplier: number
  private delta: number
  private refractory: number
  private minimumFlux: number

  constructor(options: OnsetOptions = {}) {
    const windowSeconds = options.windowSeconds ?? 1.0
    const fps = options.expectedFps ?? 60
    this.history = new Float32Array(Math.max(8, Math.round(windowSeconds * fps)))
    this.multiplier = options.multiplier ?? 1.6
    // Absolute terms, valid because spectralFlux() above is volume-invariant.
    this.delta = options.delta ?? 0.02
    this.refractory = options.refractorySeconds ?? 0.1
    this.minimumFlux = options.minimumFlux ?? 0.012
  }

  /**
   * @param flux  this frame's spectral flux
   * @param time  seconds since app start (used for the refractory window)
   */
  process(flux: number, time: number): OnsetResult {
    // Threshold from the *previous* window, before this frame joins it —
    // otherwise a large onset raises the bar it is being judged against.
    const med = median(this.history, this.historyCount)
    const threshold = med * this.multiplier + this.delta

    this.history[this.writeIndex] = flux
    this.writeIndex = (this.writeIndex + 1) % this.history.length
    if (this.historyCount < this.history.length) this.historyCount++

    const armed = time - this.lastOnsetTime >= this.refractory
    const detected = armed && flux > threshold && flux > this.minimumFlux

    let strength = 0
    if (detected) {
      this.lastOnsetTime = time
      // 1.0 when flux is double the threshold, which is a solid hit.
      const excess = (flux - threshold) / Math.max(threshold, 1e-9)
      strength = excess < 0 ? 0 : excess > 1 ? 1 : excess
      // Never emit a detected onset at strength 0 — modes use it as a trigger.
      if (strength < 0.15) strength = 0.15
    }

    return { detected, strength, flux, threshold }
  }

  reset(): void {
    this.history.fill(0)
    this.historyCount = 0
    this.writeIndex = 0
    this.lastOnsetTime = -Infinity
  }
}
