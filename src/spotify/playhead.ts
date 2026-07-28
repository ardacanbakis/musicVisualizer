/**
 * Local playhead interpolation.
 *
 * Polling runs at 4 s because of rate limits, so using the polled position
 * directly would move the playhead in 4 s jumps. Instead the position is
 * advanced locally against a monotonic clock and only corrected when it has
 * genuinely drifted, which keeps it smooth.
 *
 * Correcting on every poll would be worse than not correcting at all: network
 * latency means each response is already tens of milliseconds stale by arrival,
 * so snapping to it re-introduces exactly the jitter this exists to remove.
 * Below the drift threshold the local clock is left alone.
 *
 * Pure and clock-injectable, so it is testable without waiting in real time.
 */

/** Resync when local and reported positions differ by more than this. */
export const DRIFT_TOLERANCE_MS = 250

export interface PlayheadSample {
  /** Reported position within the track, ms. */
  progressMs: number
  /** Track length, ms. */
  durationMs: number
  isPlaying: boolean
}

export class Playhead {
  private positionMs = 0
  private durationMs = 0
  private playing = false
  private lastTick: number

  /** Number of resyncs performed; surfaced in the debug scope. */
  resyncs = 0

  constructor(now: number) {
    this.lastTick = now
  }

  /** Apply a fresh poll result. */
  sync(sample: PlayheadSample, now: number): void {
    this.advance(now)
    this.durationMs = sample.durationMs
    this.playing = sample.isPlaying

    const drift = Math.abs(sample.progressMs - this.positionMs)
    if (drift > DRIFT_TOLERANCE_MS) {
      this.positionMs = sample.progressMs
      this.resyncs++
    }
  }

  /** A track change: adopt the reported position outright, no drift check. */
  reset(sample: PlayheadSample, now: number): void {
    this.lastTick = now
    this.positionMs = sample.progressMs
    this.durationMs = sample.durationMs
    this.playing = sample.isPlaying
  }

  /** Advance the local clock. Call once per frame. */
  advance(now: number): void {
    const elapsed = now - this.lastTick
    this.lastTick = now
    if (!this.playing || elapsed <= 0) return
    // Clamped for the same reason the bus clamps dt: returning from a hidden
    // tab hands over a gap of minutes, which would run the playhead off the
    // end of the track and report a nonsense value until the next poll.
    this.positionMs += Math.min(elapsed, 5000)
    if (this.durationMs > 0 && this.positionMs > this.durationMs) {
      this.positionMs = this.durationMs
    }
  }

  /** 0..1 through the track, or null when there is nothing to report. */
  get fraction(): number | null {
    if (this.durationMs <= 0) return null
    return Math.max(0, Math.min(1, this.positionMs / this.durationMs))
  }

  get position(): number {
    return this.positionMs
  }

  get isPlaying(): boolean {
    return this.playing
  }
}
