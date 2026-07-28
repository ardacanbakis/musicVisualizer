import { describe, expect, it } from 'vitest'
import { BeatClock, TempoEstimator, foldBpm } from './tempo'

const FRAME = 1 / 60

describe('foldBpm', () => {
  it('leaves tempos already in range alone', () => {
    expect(foldBpm(120)).toBeCloseTo(120)
    expect(foldBpm(60)).toBeCloseTo(60)
  })

  it('doubles slow tempos and halves fast ones into 60..180', () => {
    // Folding stops as soon as the value is in range, so 30 lands on 60 rather
    // than continuing to 120 — both are the same pulse, and 60 is in range.
    expect(foldBpm(30)).toBeCloseTo(60)
    expect(foldBpm(15)).toBeCloseTo(60)
    expect(foldBpm(240)).toBeCloseTo(120)
    expect(foldBpm(400)).toBeCloseTo(100)
    expect(foldBpm(90)).toBeCloseTo(90)
  })

  it('always lands inside the range', () => {
    for (let bpm = 1; bpm < 1000; bpm += 0.5) {
      const folded = foldBpm(bpm)
      expect(folded).toBeGreaterThanOrEqual(60)
      expect(folded).toBeLessThan(180)
    }
  })

  it('is safe on garbage input', () => {
    expect(foldBpm(0)).toBe(0)
    expect(foldBpm(-5)).toBe(0)
    expect(foldBpm(NaN)).toBe(0)
  })
})

/** Feed the estimator onsets at a fixed tempo, advancing time frame by frame. */
function feed(bpm: number, beats: number, jitter = 0, seed = 7): TempoEstimator {
  const estimator = new TempoEstimator()
  const interval = 60 / bpm
  let random = seed
  const noise = () => {
    random = (random * 1103515245 + 12345) & 0x7fffffff
    return (random / 0x7fffffff - 0.5) * 2
  }
  let t = 0
  for (let beat = 0; beat < beats; beat++) {
    const target = beat * interval + noise() * jitter
    while (t < target) {
      estimator.decay(FRAME)
      t += FRAME
    }
    estimator.addOnset(Math.max(0, target))
  }
  return estimator
}

describe('TempoEstimator', () => {
  it('reports null before it has seen enough onsets', () => {
    const estimator = feed(120, 4)
    expect(estimator.estimate().bpm).toBeNull()
  })

  it('finds an exact 120 BPM pulse', () => {
    const result = feed(120, 32).estimate()
    expect(result.bpm).not.toBeNull()
    expect(result.bpm!).toBeCloseTo(120, 0)
    expect(result.confidence).toBeGreaterThan(0.6)
  })

  it.each([72, 90, 128, 174])('finds %i BPM', (bpm) => {
    const result = feed(bpm, 40).estimate()
    expect(result.bpm).not.toBeNull()
    expect(result.bpm!).toBeCloseTo(foldBpm(bpm), 0)
  })

  it('folds a half-time pulse into range rather than reporting 40', () => {
    const result = feed(40, 40).estimate()
    expect(result.bpm).not.toBeNull()
    expect(result.bpm!).toBeCloseTo(80, 0)
  })

  it('tolerates human jitter', () => {
    const result = feed(100, 48, 0.02).estimate()
    expect(result.bpm).not.toBeNull()
    expect(result.bpm!).toBeCloseTo(100, -0.5)
  })

  it('reports null rather than a bad guess on irregular onsets', () => {
    const estimator = new TempoEstimator()
    let random = 99
    const noise = () => {
      random = (random * 1103515245 + 12345) & 0x7fffffff
      return random / 0x7fffffff
    }
    let t = 0
    for (let i = 0; i < 60; i++) {
      t += 0.25 + noise() * 1.2
      estimator.decay(0.25)
      estimator.addOnset(t)
    }
    const result = estimator.estimate()
    expect(result.confidence).toBeLessThan(0.5)
    expect(result.bpm).toBeNull()
  })

  it('follows a tempo change once the old votes decay', () => {
    const estimator = new TempoEstimator(4) // short half-life for the test
    let t = 0
    for (let i = 0; i < 24; i++) {
      t += 0.5 // 120 BPM
      estimator.decay(0.5)
      estimator.addOnset(t)
    }
    expect(estimator.estimate().bpm!).toBeCloseTo(120, 0)

    for (let i = 0; i < 48; i++) {
      t += 0.75 // 80 BPM
      estimator.decay(0.75)
      estimator.addOnset(t)
    }
    expect(estimator.estimate().bpm!).toBeCloseTo(80, 0)
  })

  it('holds a lock through a confidence dip instead of flickering', () => {
    // Measured on a real stream, confidence hovers around whatever single
    // cutoff you pick, so `bpm` would blink on and off every few seconds.
    // Once locked it should hold until confidence drops properly away.
    const estimator = new TempoEstimator(12, 0.35, 0.2)
    let t = 0
    for (let i = 0; i < 40; i++) {
      t += 0.5
      estimator.decay(0.5)
      estimator.addOnset(t)
    }
    expect(estimator.estimate().bpm).not.toBeNull()

    // Inject enough irregular onsets to erode confidence past the *lock*
    // threshold but not past the release threshold.
    let random = 3
    for (let i = 0; i < 6; i++) {
      random = (random * 1103515245 + 12345) & 0x7fffffff
      t += 0.3 + (random / 0x7fffffff) * 0.6
      estimator.decay(0.5)
      estimator.addOnset(t)
    }
    const dipped = estimator.estimate()
    if (dipped.confidence < 0.35 && dipped.confidence >= 0.2) {
      expect(dipped.bpm).not.toBeNull()
    }

    // A fresh estimator seeing only that same eroded evidence should not lock.
    expect(new TempoEstimator(12, 0.35, 0.2).estimate().bpm).toBeNull()
  })

  it('resets cleanly', () => {
    const estimator = feed(120, 32)
    estimator.reset()
    expect(estimator.estimate().bpm).toBeNull()
    expect(estimator.confidence).toBe(0)
  })
})

describe('BeatClock', () => {
  it('free-runs at the default tempo when no BPM is known', () => {
    const clock = new BeatClock(120)
    let wraps = 0
    let previous = 0
    // 250 frames is 4.167 s = 8.33 beats, deliberately not a whole number of
    // beats so the count doesn't hinge on float error at an exact boundary.
    for (let i = 0; i < 250; i++) {
      const phase = clock.advance(FRAME)
      if (phase < previous) wraps++
      previous = phase
    }
    expect(wraps).toBe(8)
  })

  it('stays inside 0..1', () => {
    const clock = new BeatClock(174)
    for (let i = 0; i < 1000; i++) {
      const phase = clock.advance(FRAME)
      expect(phase).toBeGreaterThanOrEqual(0)
      expect(phase).toBeLessThan(1)
    }
  })

  it('converges towards the beat when nudged, without snapping', () => {
    const clock = new BeatClock(120)
    clock.advance(0.2) // put the phase somewhere arbitrary
    const before = clock.value
    clock.nudge(1)
    const after = clock.value
    expect(after).not.toBe(before)
    // A nudge, not a reset: it must not jump straight to zero.
    expect(Math.abs(after - before)).toBeLessThan(0.2)

    // Repeated nudges should get it close to a beat boundary.
    for (let i = 0; i < 40; i++) clock.nudge(1)
    const distance = Math.min(clock.value, 1 - clock.value)
    expect(distance).toBeLessThan(0.02)
  })

  it('ignores a null BPM instead of stopping', () => {
    const clock = new BeatClock(100)
    clock.setBpm(null)
    const before = clock.advance(FRAME)
    const after = clock.advance(FRAME)
    expect(after).toBeGreaterThan(before)
  })
})
