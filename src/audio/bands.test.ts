import { describe, expect, it } from 'vitest'
import {
  applyTilt,
  computeBandEdges,
  decibelsToLinear,
  foldToBands,
  spectralCentroid,
  F_MAX,
  F_MIN,
} from './bands'

describe('computeBandEdges', () => {
  const cases = [
    { fftSize: 2048, sampleRate: 48000, bandCount: 32 },
    { fftSize: 2048, sampleRate: 44100, bandCount: 32 },
    { fftSize: 2048, sampleRate: 96000, bandCount: 64 },
    // The pathological case: lots of bands, few bins.
    { fftSize: 512, sampleRate: 44100, bandCount: 32 },
  ]

  it.each(cases)(
    'produces strictly increasing edges ($sampleRate Hz, $bandCount bands)',
    ({ fftSize, sampleRate, bandCount }) => {
      const edges = computeBandEdges(bandCount, fftSize, sampleRate)
      expect(edges.length).toBe(bandCount + 1)
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i]).toBeGreaterThan(edges[i - 1])
      }
    },
  )

  it.each(cases)(
    'gives every band at least one bin ($sampleRate Hz, $bandCount bands)',
    ({ fftSize, sampleRate, bandCount }) => {
      const edges = computeBandEdges(bandCount, fftSize, sampleRate)
      for (let i = 0; i < bandCount; i++) {
        expect(edges[i + 1] - edges[i]).toBeGreaterThanOrEqual(1)
      }
    },
  )

  it('stays inside the available bins and skips DC', () => {
    const fftSize = 2048
    const edges = computeBandEdges(32, fftSize, 48000)
    expect(edges[0]).toBeGreaterThanOrEqual(1)
    expect(edges[edges.length - 1]).toBeLessThanOrEqual(fftSize / 2 - 1)
  })

  it('is log-spaced, not linear', () => {
    // The defining property: high bands are far wider in bins than low ones.
    const edges = computeBandEdges(32, 2048, 48000)
    const first = edges[1] - edges[0]
    const last = edges[32] - edges[31]
    expect(last).toBeGreaterThan(first * 8)
  })

  it('covers roughly the requested frequency range', () => {
    const sampleRate = 48000
    const fftSize = 2048
    const hzPerBin = sampleRate / fftSize
    const edges = computeBandEdges(32, fftSize, sampleRate)
    expect(edges[0] * hzPerBin).toBeLessThanOrEqual(F_MIN + hzPerBin)
    expect(edges[32] * hzPerBin).toBeGreaterThan(F_MAX * 0.85)
  })
})

describe('foldToBands', () => {
  it('averages the bins inside each band', () => {
    const spectrum = new Float32Array([0, 1, 3, 5, 7, 9])
    const edges = Int32Array.from([1, 3, 6])
    const out = new Float32Array(2)
    foldToBands(spectrum, edges, out)
    expect(out[0]).toBeCloseTo((1 + 3) / 2)
    expect(out[1]).toBeCloseTo((5 + 7 + 9) / 3)
  })

  it('maps silence to silence', () => {
    const out = foldToBands(new Float32Array(64), computeBandEdges(8, 128, 48000), new Float32Array(8))
    expect([...out].every((v) => v === 0)).toBe(true)
  })
})

describe('decibelsToLinear', () => {
  it('converts dB to amplitude', () => {
    const out = new Float32Array(3)
    decibelsToLinear(Float32Array.from([0, -20, -40]), out)
    expect(out[0]).toBeCloseTo(1)
    expect(out[1]).toBeCloseTo(0.1)
    expect(out[2]).toBeCloseTo(0.01)
  })

  it('clamps at and below the floor to exactly zero', () => {
    const out = new Float32Array(3)
    decibelsToLinear(Float32Array.from([-100, -140, -Infinity]), out, -100)
    expect([...out]).toEqual([0, 0, 0])
  })
})

describe('spectralCentroid', () => {
  it('is low for bass-heavy content and high for bright content', () => {
    const bass = Float32Array.from([1, 0.8, 0.2, 0, 0, 0, 0, 0])
    const bright = Float32Array.from([0, 0, 0, 0, 0, 0.2, 0.8, 1])
    expect(spectralCentroid(bass)).toBeLessThan(0.3)
    expect(spectralCentroid(bright)).toBeGreaterThan(0.7)
  })

  it('sits in the middle for silence rather than snapping to zero', () => {
    expect(spectralCentroid(new Float32Array(16))).toBe(0.5)
  })
})

describe('applyTilt', () => {
  it('lifts the top of the spectrum relative to the bottom', () => {
    const bands = new Float32Array(16).fill(1)
    applyTilt(bands)
    expect(bands[15]).toBeGreaterThan(bands[0])
    expect(bands[0]).toBeCloseTo(1)
  })
})
