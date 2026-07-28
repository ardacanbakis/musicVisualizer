/**
 * Contract tests for the bus.
 *
 * These are the tests that matter most in the whole suite: they assert that the
 * Signal is always fully populated regardless of which sources exist, which is
 * the promise every renderer is written against.
 */
import { describe, expect, it } from 'vitest'
import { SignalBus } from './bus'
import { BUILT_IN_PALETTES } from './palettes'
import { BAND_COUNT, WAVEFORM_SIZE } from './types'
import type { AudioFrame, AudioSource } from './sources/types'
import type { Signal } from './types'

const FRAME_MS = 1000 / 60

function runFrames(bus: SignalBus, count: number, startMs = 0): Signal {
  let signal = bus.update(startMs)
  for (let i = 1; i < count; i++) signal = bus.update(startMs + i * FRAME_MS)
  return signal
}

function assertContract(signal: Signal): void {
  expect(signal.bands.length).toBe(BAND_COUNT)
  for (const band of signal.bands) {
    expect(band).toBeGreaterThanOrEqual(0)
    expect(band).toBeLessThanOrEqual(1)
  }
  // The waveform is part of the contract too: always present, always the
  // declared length, always in range — including with no microphone.
  // Reduced to two assertions rather than one per sample: this runs 600 times
  // in one test, and 576 expect() calls a frame dominated the whole suite.
  expect(signal.waveform.length).toBe(WAVEFORM_SIZE)
  let waveMin = Infinity
  let waveMax = -Infinity
  for (const sample of signal.waveform) {
    if (sample < waveMin) waveMin = sample
    if (sample > waveMax) waveMax = sample
  }
  expect(waveMin).toBeGreaterThanOrEqual(-1)
  expect(waveMax).toBeLessThanOrEqual(1)
  expect(signal.level).toBeGreaterThanOrEqual(0)
  expect(signal.level).toBeLessThanOrEqual(1)
  expect(signal.onset).toBeGreaterThanOrEqual(0)
  expect(signal.onset).toBeLessThanOrEqual(1)
  expect(signal.beatPhase).toBeGreaterThanOrEqual(0)
  expect(signal.beatPhase).toBeLessThan(1)
  expect(signal.palette).toBeTruthy()
  expect(signal.palette.ramp.length).toBeGreaterThanOrEqual(2)
  expect(signal.dt).toBeGreaterThan(0)
  for (const key of ['energy', 'warmth', 'contrast', 'density'] as const) {
    expect(signal.mood[key]).toBeGreaterThanOrEqual(0)
    expect(signal.mood[key]).toBeLessThanOrEqual(1)
  }
}

describe('SignalBus with no sources at all', () => {
  it('satisfies the contract on the very first frame', () => {
    const bus = new SignalBus()
    assertContract(bus.update(0))
    bus.dispose()
  })

  it('keeps satisfying it over ten simulated seconds', () => {
    const bus = new SignalBus()
    for (let i = 0; i < 600; i++) assertContract(bus.update(i * FRAME_MS))
    bus.dispose()
  })

  it('is actually moving, not just valid', () => {
    // A fallback that returns constant zeroes would pass a contract check and
    // still be a dead screen.
    const bus = new SignalBus()
    const samples: number[] = []
    for (let i = 0; i < 600; i++) {
      const signal = bus.update(i * FRAME_MS)
      if (i % 20 === 0) samples.push(signal.bands[4])
    }
    const min = Math.min(...samples)
    const max = Math.max(...samples)
    expect(max - min).toBeGreaterThan(0.1)
    bus.dispose()
  })

  it('produces a moving waveform with no microphone', () => {
    // A flat line would satisfy the contract and still be a dead oscilloscope.
    const bus = new SignalBus()
    let seenNegative = false
    let seenPositive = false
    let changed = false
    let previous = 0
    for (let i = 0; i < 300; i++) {
      const signal = bus.update(i * FRAME_MS)
      for (const sample of signal.waveform) {
        if (sample < -0.05) seenNegative = true
        if (sample > 0.05) seenPositive = true
      }
      if (i > 0 && signal.waveform[10] !== previous) changed = true
      previous = signal.waveform[10]
    }
    expect(seenNegative).toBe(true)
    expect(seenPositive).toBe(true)
    expect(changed).toBe(true)
    bus.dispose()
  })

  it('produces onsets and a turning beat phase', () => {
    const bus = new SignalBus()
    let onsetSeen = 0
    let wraps = 0
    let previousPhase = 0
    for (let i = 0; i < 600; i++) {
      const signal = bus.update(i * FRAME_MS)
      if (signal.onset > 0.5) onsetSeen++
      if (signal.beatPhase < previousPhase) wraps++
      previousPhase = signal.beatPhase
    }
    expect(onsetSeen).toBeGreaterThan(0)
    expect(wraps).toBeGreaterThan(4)
    bus.dispose()
  })

  it('reports no track, no playhead, and no BPM', () => {
    const bus = new SignalBus()
    const signal = runFrames(bus, 120)
    expect(signal.track).toBeNull()
    expect(signal.playhead).toBeNull()
    // A synthetic tempo is not an estimate, and reporting it would let a mode
    // display a BPM for a silent room.
    expect(signal.bpm).toBeNull()
    bus.dispose()
  })
})

describe('SignalBus dt handling', () => {
  it('clamps the multi-second dt you get back from a hidden tab', () => {
    const bus = new SignalBus()
    bus.update(0)
    const signal = bus.update(30_000)
    expect(signal.dt).toBeLessThanOrEqual(0.1)
    assertContract(signal)
    bus.dispose()
  })

  it('survives a repeated timestamp without dividing by zero', () => {
    const bus = new SignalBus()
    bus.update(100)
    const signal = bus.update(100)
    expect(signal.dt).toBeGreaterThan(0)
    expect(Number.isFinite(signal.level)).toBe(true)
    bus.dispose()
  })

  it('starts t at zero regardless of the clock offset', () => {
    const bus = new SignalBus()
    const signal = bus.update(987_654)
    expect(signal.t).toBe(0)
    bus.dispose()
  })
})

describe('SignalBus palette handling', () => {
  it('always has a palette, before anything is set', () => {
    const bus = new SignalBus()
    expect(bus.update(0).palette).toBeTruthy()
    bus.dispose()
  })

  it('crossfades rather than hard-cutting', () => {
    const bus = new SignalBus()
    const [from, to] = BUILT_IN_PALETTES
    bus.setPalette(from, true)
    const before = bus.update(0).palette.ramp[4]

    bus.setPalette(to)
    const midway = runFrames(bus, 30, FRAME_MS).palette.ramp[4]

    // Halfway through the fade it should match neither endpoint.
    expect(midway).not.toEqual(before)
    expect(midway).not.toEqual(to.ramp[4])
    bus.dispose()
  })

  it('completes the fade in about two seconds', () => {
    const bus = new SignalBus()
    const [from, to] = BUILT_IN_PALETTES
    bus.setPalette(from, true)
    bus.update(0)
    bus.setPalette(to)
    const after = runFrames(bus, 200, FRAME_MS) // ~3.3 s
    expect(after.palette.ramp[4]).toEqual(to.ramp[4])
    bus.dispose()
  })

  it('applies an immediate palette without a fade', () => {
    const bus = new SignalBus()
    bus.setPalette(BUILT_IN_PALETTES[3], true)
    expect(bus.update(0).palette.ramp[2]).toEqual(BUILT_IN_PALETTES[3].ramp[2])
    bus.dispose()
  })
})

describe('SignalBus source swapping', () => {
  class StubSource implements AudioSource {
    readonly id = 'stub'
    readonly label = 'Stub'
    disposed = false
    poll(_dt: number, _t: number, out: AudioFrame): void {
      out.bands.fill(0.5)
      out.waveform.fill(0.25)
      out.level = 0.5
      out.onset = 0
      out.beatPhase = 0.25
      out.bpm = 128
    }
    dispose(): void {
      this.disposed = true
    }
  }

  it('uses a swapped-in source', () => {
    const bus = new SignalBus()
    bus.setAudioSource(new StubSource())
    const signal = bus.update(0)
    expect(signal.bands[0]).toBe(0.5)
    expect(signal.bpm).toBe(128)
    expect(bus.sourceId).toBe('stub')
    bus.dispose()
  })

  it('disposes the outgoing source on swap', () => {
    const bus = new SignalBus()
    const first = new StubSource()
    bus.setAudioSource(first)
    bus.setAudioSource(null)
    expect(first.disposed).toBe(true)
    expect(bus.sourceId).toBe('synthetic')
    bus.dispose()
  })

  it('falls back instead of crashing when a source throws', () => {
    // A wall display cannot die because a MediaStream went away at 3am.
    const bus = new SignalBus()
    bus.setAudioSource({
      id: 'broken',
      label: 'Broken',
      poll() {
        throw new Error('device disconnected')
      },
      dispose() {},
    })
    const signal = bus.update(0)
    assertContract(signal)
    expect(bus.sourceId).toBe('synthetic')
    bus.dispose()
  })

  it('reverts to the synthetic source when handed null', () => {
    const bus = new SignalBus()
    bus.setAudioSource(new StubSource())
    bus.setAudioSource(null)
    assertContract(runFrames(bus, 120))
    bus.dispose()
  })
})

describe('SignalBus mood', () => {
  it('drifts rather than jumping frame to frame', () => {
    const bus = new SignalBus()
    let previous = bus.update(0).mood.energy
    for (let i = 1; i < 600; i++) {
      const energy = bus.update(i * FRAME_MS).mood.energy
      expect(Math.abs(energy - previous)).toBeLessThan(0.05)
      previous = energy
    }
    bus.dispose()
  })

  it('reads a warm palette as warmer than a cold one', () => {
    const warm = new SignalBus()
    const cold = new SignalBus()
    warm.setPalette(BUILT_IN_PALETTES.find((p) => p.id === 'ember')!, true)
    cold.setPalette(BUILT_IN_PALETTES.find((p) => p.id === 'abyss')!, true)
    const warmMood = runFrames(warm, 600).mood.warmth
    const coldMood = runFrames(cold, 600).mood.warmth
    expect(warmMood).toBeGreaterThan(coldMood)
    warm.dispose()
    cold.dispose()
  })
})
