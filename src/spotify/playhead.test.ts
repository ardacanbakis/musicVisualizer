import { describe, expect, it } from 'vitest'
import { DRIFT_TOLERANCE_MS, Playhead } from './playhead'

const track = { durationMs: 200_000, isPlaying: true }

describe('Playhead', () => {
  it('advances locally between polls', () => {
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 10_000 }, 0)
    head.advance(1000)
    expect(head.position).toBe(11_000)
  })

  it('does not advance while paused', () => {
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 5000, isPlaying: false }, 0)
    head.advance(3000)
    expect(head.position).toBe(5000)
  })

  it('ignores drift below the tolerance', () => {
    // Every response is already stale by its network latency, so snapping to
    // each poll would reintroduce the jitter interpolation exists to remove.
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 10_000 }, 0)
    head.sync({ ...track, progressMs: 11_100 }, 1000) // local would be 11_000
    expect(head.resyncs).toBe(0)
    expect(head.position).toBe(11_000)
  })

  it('resyncs when drift exceeds the tolerance', () => {
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 10_000 }, 0)
    // A seek: reported position is far from where the local clock had got to.
    head.sync({ ...track, progressMs: 60_000 }, 1000)
    expect(head.resyncs).toBe(1)
    expect(head.position).toBe(60_000)
  })

  it('uses exactly the documented tolerance', () => {
    const under = new Playhead(0)
    under.reset({ ...track, progressMs: 0 }, 0)
    under.sync({ ...track, progressMs: 1000 + DRIFT_TOLERANCE_MS - 1 }, 1000)
    expect(under.resyncs).toBe(0)

    const over = new Playhead(0)
    over.reset({ ...track, progressMs: 0 }, 0)
    over.sync({ ...track, progressMs: 1000 + DRIFT_TOLERANCE_MS + 1 }, 1000)
    expect(over.resyncs).toBe(1)
  })

  it('reports a fraction in 0..1', () => {
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 100_000 }, 0)
    expect(head.fraction).toBeCloseTo(0.5)
  })

  it('reports null with no duration rather than dividing by zero', () => {
    const head = new Playhead(0)
    head.reset({ progressMs: 0, durationMs: 0, isPlaying: false }, 0)
    expect(head.fraction).toBeNull()
  })

  it('never runs past the end of the track', () => {
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 199_000 }, 0)
    head.advance(10_000)
    expect(head.position).toBe(200_000)
    expect(head.fraction).toBe(1)
  })

  it('clamps the huge gap a hidden tab hands back', () => {
    // Same hazard the bus guards against: a multi-minute jump would run the
    // playhead off the end and report nonsense until the next poll.
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 1000 }, 0)
    head.advance(600_000)
    expect(head.position).toBeLessThanOrEqual(6000)
  })

  it('adopts a track change outright without counting a resync', () => {
    const head = new Playhead(0)
    head.reset({ ...track, progressMs: 150_000 }, 0)
    head.reset({ durationMs: 90_000, progressMs: 0, isPlaying: true }, 1000)
    expect(head.position).toBe(0)
    expect(head.resyncs).toBe(0)
  })
})
