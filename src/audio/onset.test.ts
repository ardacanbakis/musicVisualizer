import { describe, expect, it } from 'vitest'
import { OnsetDetector, median, spectralFlux } from './onset'

const FRAME = 1 / 60
const BINS = 64

/**
 * Synthetic spectrum generator: a steady bed of energy with a percussive hit
 * every `interval` seconds that decays over ~120 ms. Close enough to a kick
 * drum's spectral signature to exercise the detector honestly.
 */
function makeStream(interval: number, seconds: number, bed = 0.01) {
  const frames: Float32Array[] = []
  const steps = Math.round(seconds / FRAME)
  let energy = 0
  let nextHit = interval
  for (let i = 0; i < steps; i++) {
    const t = i * FRAME
    if (t >= nextHit) {
      energy = 1
      nextHit += interval
    }
    const spectrum = new Float32Array(BINS)
    for (let b = 0; b < BINS; b++) {
      spectrum[b] = bed + energy * (1 - b / BINS) * 0.6
    }
    frames.push(spectrum)
    energy *= Math.exp(-FRAME / 0.12)
  }
  return frames
}

function detectAll(frames: Float32Array[], detector = new OnsetDetector()) {
  const times: number[] = []
  let previous: Float32Array<ArrayBufferLike> = new Float32Array(BINS)
  frames.forEach((spectrum, i) => {
    const t = i * FRAME
    const flux = spectralFlux(spectrum, previous)
    previous = spectrum
    if (detector.process(flux, t).detected) times.push(t)
  })
  return times
}

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median(Float32Array.from([3, 1, 2]))).toBe(2)
    expect(median(Float32Array.from([4, 1, 3, 2]))).toBe(2.5)
  })

  it('is unmoved by a single large outlier — the reason we use it', () => {
    const calm = Float32Array.from([1, 1, 1, 1, 1])
    const spiked = Float32Array.from([1, 1, 1, 1, 1000])
    expect(median(spiked)).toBe(median(calm))
  })

  it('honours the count argument for a partly-filled ring', () => {
    expect(median(Float32Array.from([5, 7, 0, 0, 0]), 2)).toBe(6)
  })

  it('returns zero for an empty window', () => {
    expect(median(new Float32Array(8), 0)).toBe(0)
  })
})

describe('spectralFlux', () => {
  it('ignores energy that is falling', () => {
    const loud = Float32Array.from([1, 1, 1, 1])
    const quiet = Float32Array.from([0.2, 0.2, 0.2, 0.2])
    expect(spectralFlux(quiet, loud)).toBe(0)
    expect(spectralFlux(loud, quiet)).toBeGreaterThan(0)
  })

  it('is volume invariant', () => {
    // The same musical event at two different room volumes must give the
    // same flux, otherwise every threshold below needs retuning per room.
    const before = Float32Array.from([0.1, 0.1, 0.1, 0.1])
    const after = Float32Array.from([0.5, 0.5, 0.5, 0.5])
    const scale = (a: Float32Array, k: number) => a.map((v) => v * k)
    expect(spectralFlux(after, before)).toBeCloseTo(
      spectralFlux(scale(after, 20), scale(before, 20)),
      6,
    )
  })

  it('is zero for silence and zero for a steady signal', () => {
    expect(spectralFlux(new Float32Array(8), new Float32Array(8))).toBe(0)
    const steady = new Float32Array(8).fill(0.4)
    expect(spectralFlux(steady, steady)).toBe(0)
  })
})

describe('OnsetDetector', () => {
  it('finds one onset per hit at 120 BPM', () => {
    const times = detectAll(makeStream(0.5, 8))
    // 8 s at one hit every 0.5 s, minus the first (no previous frame to
    // compare against on the very first hit is fine, but allow ±1 either way).
    expect(times.length).toBeGreaterThanOrEqual(14)
    expect(times.length).toBeLessThanOrEqual(16)
  })

  it('spaces detections at the true interval', () => {
    const times = detectAll(makeStream(0.5, 8))
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(0.5, 1)
    }
  })

  it('respects the refractory period', () => {
    const detector = new OnsetDetector({ refractorySeconds: 0.25 })
    // Every frame is a step upward, so without a refractory window this would
    // fire ~60 times a second.
    const times: number[] = []
    let previous = new Float32Array(BINS).fill(0.01)
    for (let i = 0; i < 300; i++) {
      const spectrum = new Float32Array(BINS).fill(0.01 + (i % 2) * 0.5)
      const flux = spectralFlux(spectrum, previous)
      previous = spectrum
      if (detector.process(flux, i * FRAME).detected) times.push(i * FRAME)
    }
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.25 - 1e-9)
    }
  })

  it('fires nothing on silence', () => {
    const frames = Array.from({ length: 600 }, () => new Float32Array(BINS))
    expect(detectAll(frames)).toEqual([])
  })

  it('fires once when a drone starts, then goes quiet', () => {
    // The drone beginning genuinely *is* an onset — sound appearing out of
    // silence is the textbook case. What must not happen is it continuing to
    // fire for the ten seconds the drone is sustained.
    const frames = Array.from({ length: 600 }, () => new Float32Array(BINS).fill(0.3))
    const times = detectAll(frames)
    expect(times.length).toBe(1)
    expect(times[0]).toBe(0)
  })

  it('adapts to dense material instead of firing every frame', () => {
    // Continuous noise with constant churn: a fixed threshold would fire
    // relentlessly here. The adaptive median should keep it in check.
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const frames = Array.from({ length: 600 }, () => {
      const spectrum = new Float32Array(BINS)
      for (let b = 0; b < BINS; b++) spectrum[b] = 0.2 + random() * 0.2
      return spectrum
    })
    const times = detectAll(frames)
    // Far below the 10/s a fixed threshold would produce on this input.
    expect(times.length).toBeLessThan(30)
  })

  it('reports a strength in 0..1 whenever it fires', () => {
    const detector = new OnsetDetector()
    let previous: Float32Array<ArrayBufferLike> = new Float32Array(BINS)
    let fired = 0
    makeStream(0.4, 6).forEach((spectrum, i) => {
      const flux = spectralFlux(spectrum, previous)
      previous = spectrum
      const result = detector.process(flux, i * FRAME)
      if (result.detected) {
        fired++
        expect(result.strength).toBeGreaterThan(0)
        expect(result.strength).toBeLessThanOrEqual(1)
      } else {
        expect(result.strength).toBe(0)
      }
    })
    expect(fired).toBeGreaterThan(5)
  })
})
