import { describe, expect, it } from 'vitest'
import { EnvelopeFollower, followScalar, timeConstantCoefficient } from './envelope'

const FRAME = 1 / 60

function run(follower: EnvelopeFollower, value: number, seconds: number): number {
  // Input must match the follower's width — a short array reads as undefined
  // and poisons the envelope with NaN.
  const input = new Float32Array(follower.value.length).fill(value)
  const steps = Math.round(seconds / FRAME)
  for (let i = 0; i < steps; i++) follower.process(input, FRAME)
  return follower.value[0]
}

describe('timeConstantCoefficient', () => {
  it('treats a zero time constant as instant', () => {
    expect(timeConstantCoefficient(0, FRAME)).toBe(1)
  })

  it('stays within 0..1 for absurd dt', () => {
    expect(timeConstantCoefficient(0.5, 10)).toBeLessThanOrEqual(1)
    expect(timeConstantCoefficient(0.5, 1e-9)).toBeGreaterThanOrEqual(0)
  })
})

describe('EnvelopeFollower', () => {
  it('rises faster than it falls', () => {
    const follower = new EnvelopeFollower(1, { attack: 0.01, release: 0.3 })

    const afterRise = run(follower, 1, 0.05)
    follower.reset()
    run(follower, 1, 2) // settle at 1
    const beforeFall = follower.value[0]
    const afterFall = run(follower, 0, 0.05)

    const risen = afterRise
    const fallen = beforeFall - afterFall
    expect(risen).toBeGreaterThan(fallen)
  })

  it('reaches ~63% of a step after one attack time constant', () => {
    const follower = new EnvelopeFollower(1, { attack: 0.1, release: 10 })
    expect(run(follower, 1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 1)
  })

  it('is frame-rate independent', () => {
    const at60 = new EnvelopeFollower(1, { attack: 0.05, release: 0.4 })
    const at144 = new EnvelopeFollower(1, { attack: 0.05, release: 0.4 })
    const input = Float32Array.from([1])

    for (let i = 0; i < 60; i++) at60.process(input, 1 / 60)
    for (let i = 0; i < 144; i++) at144.process(input, 1 / 144)

    expect(at60.value[0]).toBeCloseTo(at144.value[0], 3)
  })

  it('decays to exactly zero in silence, with no residual', () => {
    const follower = new EnvelopeFollower(4, { attack: 0.01, release: 0.15 })
    run(follower, 1, 1)
    const silence = new Float32Array(4)
    for (let i = 0; i < 60 * 5; i++) follower.process(silence, FRAME)
    expect([...follower.value]).toEqual([0, 0, 0, 0])
  })

  it('never overshoots a constant input', () => {
    const follower = new EnvelopeFollower(1, { attack: 0.01, release: 0.2 })
    const input = Float32Array.from([0.7])
    for (let i = 0; i < 600; i++) {
      follower.process(input, FRAME)
      expect(follower.value[0]).toBeLessThanOrEqual(0.7 + 1e-6)
    }
  })
})

describe('followScalar', () => {
  it('snaps small values to zero so silence is exact', () => {
    expect(followScalar(1e-8, 0, FRAME)).toBe(0)
  })

  it('moves towards the target monotonically', () => {
    let value = 0
    for (let i = 0; i < 100; i++) {
      const next = followScalar(value, 1, FRAME)
      expect(next).toBeGreaterThanOrEqual(value)
      value = next
    }
    expect(value).toBeGreaterThan(0.9)
  })
})
