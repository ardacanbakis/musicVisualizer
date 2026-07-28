import { describe, expect, it } from 'vitest'
import { NoiseGate, RollingNormaliser, normaliseScalar } from './normalise'

const FRAME = 1 / 60

function settle(normaliser: RollingNormaliser, value: number, seconds: number): Float32Array {
  const input = new Float32Array(normaliser.output.length).fill(value)
  const steps = Math.round(seconds / FRAME)
  for (let i = 0; i < steps; i++) normaliser.process(input, FRAME)
  return normaliser.output
}

describe('RollingNormaliser', () => {
  it('makes a quiet room and a loud room look the same', () => {
    // The whole point: the visuals must not need a gain slider.
    const quiet = new RollingNormaliser(4)
    const loud = new RollingNormaliser(4)
    const quietOut = settle(quiet, 0.02, 2)[0]
    const loudOut = settle(loud, 0.9, 2)[0]
    expect(quietOut).toBeCloseTo(loudOut, 5)
    expect(quietOut).toBeCloseTo(1, 5)
  })

  it('does not amplify silence — the floor holds', () => {
    const normaliser = new RollingNormaliser(4, { floor: 0.01 })
    const out = settle(normaliser, 0, 30)
    expect([...out]).toEqual([0, 0, 0, 0])
  })

  it('keeps a signal at the floor from reading as full scale', () => {
    const normaliser = new RollingNormaliser(1, { floor: 0.01 })
    // A signal a tenth of the floor should stay visibly quiet, not be
    // stretched to 1 the way an unfloored normaliser would stretch it.
    const out = settle(normaliser, 0.001, 30)
    expect(out[0]).toBeCloseTo(0.1, 3)
  })

  it('never clips a transient — attack is instant', () => {
    const normaliser = new RollingNormaliser(1, { floor: 0.001 })
    settle(normaliser, 0.05, 5)
    const spike = normaliser.process(Float32Array.from([0.9]), FRAME)
    expect(spike[0]).toBeCloseTo(1, 5)
  })

  it('output is always within 0..1', () => {
    const normaliser = new RollingNormaliser(3)
    for (let i = 0; i < 2000; i++) {
      const input = Float32Array.from([Math.random() * 4, 0, Math.random()])
      const out = normaliser.process(input, FRAME)
      for (const value of out) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    }
  })

  it('adapts downward when the room gets quieter', () => {
    const normaliser = new RollingNormaliser(1, { halfLife: 2 })
    settle(normaliser, 1, 3)
    // Drop to a tenth. Immediately after, the output should be low; after
    // several half-lives it should have climbed back towards full scale.
    const immediate = normaliser.process(Float32Array.from([0.1]), FRAME)[0]
    expect(immediate).toBeLessThan(0.2)
    const later = settle(normaliser, 0.1, 20)[0]
    expect(later).toBeGreaterThan(0.9)
  })
})

describe('normaliseScalar', () => {
  it('tracks the peak the same way the array version does', () => {
    let peak = 0
    let value = 0
    for (let i = 0; i < 240; i++) {
      const result = normaliseScalar(0.3, peak, FRAME)
      peak = result.peak
      value = result.value
    }
    expect(value).toBeCloseTo(1, 5)
  })
})

describe('NoiseGate', () => {
  it('opens above the open threshold and closes below the close threshold', () => {
    const gate = new NoiseGate(0.01, 0.005, 0.05)
    for (let i = 0; i < 60; i++) gate.process(0.02, FRAME)
    expect(gate.isOpen).toBe(true)
    for (let i = 0; i < 60; i++) gate.process(0.001, FRAME)
    expect(gate.isOpen).toBe(false)
  })

  it('does not chatter on a signal sitting between the thresholds', () => {
    // This is the whole reason for hysteresis: a single threshold flips state
    // every few frames here, which reads on screen as flicker.
    const gate = new NoiseGate(0.01, 0.005, 0.05)
    for (let i = 0; i < 30; i++) gate.process(0.02, FRAME) // open it
    let transitions = 0
    let previous = gate.isOpen
    for (let i = 0; i < 600; i++) {
      // Wander around 0.0075 — between close (0.005) and open (0.01).
      gate.process(0.0075 + Math.sin(i * 0.7) * 0.002, FRAME)
      if (gate.isOpen !== previous) transitions++
      previous = gate.isOpen
    }
    expect(transitions).toBe(0)
  })

  it('fades rather than switching, and reaches exactly zero', () => {
    const gate = new NoiseGate(0.01, 0.005, 0.3)
    for (let i = 0; i < 300; i++) gate.process(0.02, FRAME)
    expect(gate.process(0.0, FRAME)).toBeGreaterThan(0.9) // no instant cut
    for (let i = 0; i < 600; i++) gate.process(0, FRAME)
    expect(gate.process(0, FRAME)).toBe(0)
  })
})
