/**
 * Rolling per-band normalisation and the noise gate.
 *
 * The problem: raw band energy depends entirely on how loud the room is and how
 * far away the speakers are. Without normalisation the visuals are either a
 * flat line or permanently clipped, and the user ends up hunting for a gain
 * slider. With it, quiet jazz at 3am and a party at midnight both fill the
 * range.
 *
 * The implementation is a decaying peak-hold — a windowed maximum expressed as
 * an IIR rather than a ring buffer. It costs one float per band instead of
 * hundreds, and more importantly it decays *smoothly*: a true sliding-window
 * max drops discontinuously when the old peak falls out of the window, which
 * shows up on screen as a visible step change in brightness.
 *
 * The floor is the other half. Divide by a peak that is allowed to reach zero
 * and silence gets amplified into full-scale noise; the floor caps how much
 * gain a quiet signal can earn.
 */

export interface NormaliserOptions {
  /**
   * Seconds for the peak to fall to half its value once the signal drops.
   * Long enough to survive a quiet passage, short enough to adapt to a new track.
   */
  halfLife?: number
  /**
   * Smallest peak we will ever divide by. Sets the maximum gain applied to a
   * quiet signal, and therefore how much of a silent room's noise floor shows.
   */
  floor?: number
}

const DEFAULT_HALF_LIFE = 8
const DEFAULT_FLOOR = 0.008

export class RollingNormaliser {
  readonly peak: Float32Array
  readonly output: Float32Array
  private decayPerSecond: number
  private floor: number

  constructor(size: number, options: NormaliserOptions = {}) {
    const halfLife = options.halfLife ?? DEFAULT_HALF_LIFE
    this.floor = options.floor ?? DEFAULT_FLOOR
    // 0.5 ** (dt / halfLife) per frame == this ** dt
    this.decayPerSecond = Math.pow(0.5, 1 / halfLife)
    this.peak = new Float32Array(size).fill(this.floor)
    this.output = new Float32Array(size)
  }

  process(input: Float32Array, dt: number): Float32Array {
    const decay = Math.pow(this.decayPerSecond, dt)
    const peak = this.peak
    const out = this.output
    const floor = this.floor
    for (let i = 0; i < out.length; i++) {
      const x = input[i]
      let p = peak[i] * decay
      if (p < floor) p = floor
      if (x > p) p = x // instant attack: never clip a transient
      peak[i] = p
      const v = x / p
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
    return out
  }

  reset(): void {
    this.peak.fill(this.floor)
    this.output.fill(0)
  }
}

/** Scalar form, for `level`. Returns the new peak alongside the normalised value. */
export function normaliseScalar(
  input: number,
  peak: number,
  dt: number,
  halfLife = DEFAULT_HALF_LIFE,
  floor = DEFAULT_FLOOR,
): { value: number; peak: number } {
  let p = peak * Math.pow(Math.pow(0.5, 1 / halfLife), dt)
  if (p < floor) p = floor
  if (input > p) p = input
  const v = input / p
  return { value: v < 0 ? 0 : v > 1 ? 1 : v, peak: p }
}

/**
 * Noise gate with hysteresis.
 *
 * A single threshold chatters: a signal hovering right at the line flips the
 * gate open and shut every few frames, which reads on screen as flickering.
 * Two thresholds (open high, close low) plus a smoothed gain make the gate
 * fade rather than switch, so silence arrives cleanly and stays put.
 */
export class NoiseGate {
  private open = false
  private gain = 0

  constructor(
    /**
     * Level above which the gate opens.
     *
     * Scale note: this is compared against the mean linear amplitude across
     * all bands, which is much smaller than intuition suggests — a clearly
     * audible track measures around 1e-3, because most bands are quiet most of
     * the time and the mean drags them all in. Thresholds set by eye land an
     * order of magnitude too high and leave real music permanently half-gated.
     * These are set from measurement against a reference track.
     */
    private openThreshold = 3e-4,
    /** Level below which it closes. Must be < openThreshold. */
    private closeThreshold = 1.2e-4,
    /** Seconds to fade the gate in/out. */
    private fade = 0.15,
  ) {}

  /** Returns a gain in 0..1 to multiply the signal by. */
  process(level: number, dt: number): number {
    if (this.open) {
      if (level < this.closeThreshold) this.open = false
    } else if (level > this.openThreshold) {
      this.open = true
    }
    const target = this.open ? 1 : 0
    const k = this.fade <= 0 ? 1 : 1 - Math.exp(-dt / this.fade)
    this.gain += (target - this.gain) * k
    if (this.gain < 1e-4) this.gain = 0
    if (this.gain > 0.9999) this.gain = 1
    return this.gain
  }

  get isOpen(): boolean {
    return this.open
  }

  reset(): void {
    this.open = false
    this.gain = 0
  }
}
