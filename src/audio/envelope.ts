/**
 * Asymmetric envelope follower.
 *
 * Symmetric smoothing forces a bad trade: fast enough to feel responsive means
 * jittery, smooth enough to look calm means mushy and late. Asymmetric solves
 * it — snap up on transients (short attack), ease down afterwards (long
 * release). This is why a fast attack / slow release follower feels "musical"
 * and a plain EMA does not.
 *
 * Time constants are in seconds and are frame-rate independent: the per-frame
 * coefficient is derived from dt, so 60 Hz and 144 Hz behave identically.
 */

export interface EnvelopeOptions {
  /** Seconds to reach ~63% of a step up. Small = punchy. */
  attack?: number
  /** Seconds to fall to ~37% of a step down. Large = smooth trails. */
  release?: number
}

const DEFAULT_ATTACK = 0.012
const DEFAULT_RELEASE = 0.22

/**
 * Convert a time constant to a per-frame lerp coefficient.
 * tau <= 0 means "instant", which we express as coefficient 1.
 */
export function timeConstantCoefficient(tau: number, dt: number): number {
  if (tau <= 0) return 1
  const k = 1 - Math.exp(-dt / tau)
  return k < 0 ? 0 : k > 1 ? 1 : k
}

export class EnvelopeFollower {
  readonly value: Float32Array
  private attack: number
  private release: number

  constructor(size: number, options: EnvelopeOptions = {}) {
    this.value = new Float32Array(size)
    this.attack = options.attack ?? DEFAULT_ATTACK
    this.release = options.release ?? DEFAULT_RELEASE
  }

  setTimes(attack: number, release: number): void {
    this.attack = attack
    this.release = release
  }

  /** Advance the envelope towards `input`. Writes into (and returns) `this.value`. */
  process(input: Float32Array, dt: number): Float32Array {
    const up = timeConstantCoefficient(this.attack, dt)
    const down = timeConstantCoefficient(this.release, dt)
    const value = this.value
    for (let i = 0; i < value.length; i++) {
      const target = input[i]
      const current = value[i]
      const k = target > current ? up : down
      let next = current + (target - current) * k
      // Denormal guard: without this the tail asymptotes at ~1e-30 forever and
      // some GPUs/CPUs get slow multiplying it. Silence must be exactly 0.
      if (next < 1e-7) next = 0
      value[i] = next
    }
    return value
  }

  reset(): void {
    this.value.fill(0)
  }
}

/** Single-value convenience form, for `level`. */
export function followScalar(
  current: number,
  target: number,
  dt: number,
  attack = DEFAULT_ATTACK,
  release = DEFAULT_RELEASE,
): number {
  const k = timeConstantCoefficient(target > current ? attack : release, dt)
  const next = current + (target - current) * k
  return next < 1e-7 ? 0 : next
}
