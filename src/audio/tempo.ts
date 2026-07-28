/**
 * Tempo estimation by inter-onset-interval histogram, plus the beat clock.
 *
 * Approach: every time an onset arrives, measure the interval back to the
 * previous few onsets, convert each to a BPM, fold it into 60-180, and drop a
 * vote into a histogram. Regular music piles votes onto one bin; irregular
 * audio spreads them evenly. The ratio between the peak and the total is
 * therefore a usable confidence, and the brief is explicit that we report
 * `null` rather than a bad guess — a visual pulsing at the wrong tempo looks
 * far worse than one that is not pulsing at all.
 *
 * Only lags 1 and 2 are used. Lag 2 spans two beats, which folds back onto the
 * true tempo exactly (half tempo doubles to the same value). Lag 3 spans three,
 * which folds to 1.5x and votes for a tempo that isn't there.
 */

/** Fold any tempo into the 60..180 range by doubling or halving. */
export function foldBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0
  let value = bpm
  let guard = 0
  while (value < 60 && guard++ < 16) value *= 2
  while (value >= 180 && guard++ < 32) value /= 2
  return value
}

const BPM_MIN = 60
const BPM_MAX = 180
const BIN_COUNT = 120 // 1 BPM per bin
const MIN_INTERVAL = 0.2 // 300 BPM — faster than this is a double-trigger
const MAX_INTERVAL = 2.5 // 24 BPM — slower than this is not a beat
const MAX_LAG = 2
const HISTORY = 24

export interface TempoEstimate {
  bpm: number | null
  /** 0..1. `bpm` is null below the confidence threshold. */
  confidence: number
}

export class TempoEstimator {
  private onsetTimes: number[] = []
  private histogram = new Float32Array(BIN_COUNT)
  private lastBpm: number | null = null
  private lastConfidence = 0

  private locked = false

  constructor(
    /** Seconds for a vote to decay to half weight. Lets tempo changes take over. */
    private halfLife = 12,
    /** Confidence needed to start reporting a BPM. */
    private threshold = 0.35,
    /** Confidence needed to keep reporting one. See the hysteresis note below. */
    private releaseThreshold = 0.2,
    /** Onsets needed before we report anything, however confident it looks. */
    private minimumOnsets = 8,
  ) {}

  /** Call once per frame to age the histogram. */
  decay(dt: number): void {
    const factor = Math.pow(0.5, dt / this.halfLife)
    const h = this.histogram
    for (let i = 0; i < h.length; i++) {
      const v = h[i] * factor
      h[i] = v < 1e-6 ? 0 : v
    }
  }

  /** Call on every detected onset. */
  addOnset(time: number, strength = 1): void {
    const times = this.onsetTimes
    const lags = Math.min(MAX_LAG, times.length)
    for (let lag = 1; lag <= lags; lag++) {
      const interval = time - times[times.length - lag]
      if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) continue
      const bpm = foldBpm(60 / interval)
      // Lag 2 is a weaker piece of evidence than lag 1: more room for a missed
      // onset in between to have corrupted it.
      this.vote(bpm, strength / lag)
    }
    times.push(time)
    if (times.length > HISTORY) times.shift()
  }

  /**
   * Spread each vote over neighbouring bins. Real tempo drifts and onset times
   * are quantised to the frame rate, so hard binning splits one tempo across
   * two adjacent bins and halves its apparent confidence.
   */
  private vote(bpm: number, weight: number): void {
    if (bpm < BPM_MIN || bpm >= BPM_MAX) return
    const centre = ((bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * BIN_COUNT
    const spread = 2
    for (let offset = -spread; offset <= spread; offset++) {
      const bin = Math.round(centre) + offset
      if (bin < 0 || bin >= BIN_COUNT) continue
      const falloff = Math.exp(-(offset * offset) / (2 * 1.0 * 1.0))
      this.histogram[bin] += weight * falloff
    }
  }

  estimate(): TempoEstimate {
    if (this.onsetTimes.length < this.minimumOnsets) {
      this.lastConfidence = 0
      this.lastBpm = null
      this.locked = false
      return { bpm: null, confidence: 0 }
    }

    let peakBin = 0
    let peakValue = 0
    let total = 0
    const h = this.histogram
    for (let i = 0; i < BIN_COUNT; i++) {
      total += h[i]
      if (h[i] > peakValue) {
        peakValue = h[i]
        peakBin = i
      }
    }
    if (total <= 1e-6) return { bpm: null, confidence: 0 }

    // Weight of the whole peak, not just its highest bin.
    //
    // The window has to be this wide because onset times are quantised to the
    // frame rate. One frame of error (16.7 ms) on a 250 ms interval is 6.7%,
    // which at 240 BPM before folding is ±8 BPM — so a perfectly metronomic
    // track still spreads its votes over a dozen bins. Measured against a
    // synthetic 120 BPM reference, a ±3 window scored it at 26-33% and made
    // the estimate flicker in and out of confidence; ±7 scores the same track
    // where it belongs.
    let peakMass = 0
    for (let i = peakBin - 7; i <= peakBin + 7; i++) {
      if (i >= 0 && i < BIN_COUNT) peakMass += h[i]
    }
    const confidence = Math.min(1, peakMass / total)

    // Sub-bin interpolation against the neighbours, so the reported BPM is not
    // quantised to whole numbers.
    const left = peakBin > 0 ? h[peakBin - 1] : 0
    const right = peakBin < BIN_COUNT - 1 ? h[peakBin + 1] : 0
    const denominator = left - 2 * peakValue + right
    const shift = denominator !== 0 ? (0.5 * (left - right)) / denominator : 0
    const bin = peakBin + (Number.isFinite(shift) ? Math.max(-1, Math.min(1, shift)) : 0)
    const bpm = BPM_MIN + (bin / BIN_COUNT) * (BPM_MAX - BPM_MIN)

    // Hysteresis on the report decision, for the same reason the noise gate has
    // it. Confidence on real material hovers around whatever single threshold
    // you pick, so a lone cutoff makes `bpm` appear and vanish every few
    // seconds — and a mode that starts and stops pulsing looks far more broken
    // than one that never pulses at all. Harder to lock than to hold.
    this.locked = confidence >= (this.locked ? this.releaseThreshold : this.threshold)

    this.lastConfidence = confidence
    this.lastBpm = this.locked ? bpm : null
    return { bpm: this.lastBpm, confidence }
  }

  get confidence(): number {
    return this.lastConfidence
  }

  reset(): void {
    this.onsetTimes = []
    this.histogram.fill(0)
    this.lastBpm = null
    this.lastConfidence = 0
    this.locked = false
  }
}

/**
 * Free-running beat phase, softly locked to detected onsets.
 *
 * `beatPhase` is contractually always present, so this keeps turning at a
 * default tempo even when the estimator has nothing. When onsets do arrive it
 * is nudged — not snapped — towards them: a hard reset on every onset makes the
 * phase stutter visibly on syncopation, whereas a weak pull converges over a
 * bar or two and stays smooth throughout.
 */
export class BeatClock {
  private phase = 0
  private bpm: number

  constructor(defaultBpm = 110, private lockStrength = 0.12) {
    this.bpm = defaultBpm
  }

  setBpm(bpm: number | null): void {
    if (bpm !== null && bpm > 0) this.bpm = bpm
  }

  advance(dt: number): number {
    this.phase += (this.bpm / 60) * dt
    this.phase -= Math.floor(this.phase)
    return this.phase
  }

  /** Pull the phase towards the nearest beat boundary. */
  nudge(strength = 1): void {
    const error = this.phase < 0.5 ? -this.phase : 1 - this.phase
    this.phase += error * this.lockStrength * Math.min(1, strength)
    this.phase -= Math.floor(this.phase)
  }

  get value(): number {
    return this.phase
  }

  reset(): void {
    this.phase = 0
  }
}
