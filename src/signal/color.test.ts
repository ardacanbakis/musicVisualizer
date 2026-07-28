import { describe, expect, it } from 'vitest'
import {
  buildPalette,
  hexToRgb,
  hueVariance,
  luminance,
  luminanceHistogram,
  meanSaturation,
  mixPalette,
  rgbToHex,
  rgbToHsl,
} from './color'
import { BUILT_IN_PALETTES } from './palettes'
import { sampleRamp } from './types'
import type { RGB } from './types'

describe('hex conversion', () => {
  it('round-trips', () => {
    for (const hex of ['#000000', '#ffffff', '#3fb06a', '#12798c']) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex)
    }
  })

  it('expands shorthand', () => {
    expect(hexToRgb('#f00')).toEqual(hexToRgb('#ff0000'))
  })
})

describe('rgbToHsl', () => {
  it('reports zero saturation for greys', () => {
    expect(rgbToHsl([0.5, 0.5, 0.5])[1]).toBe(0)
  })

  it('places primaries at the right hues', () => {
    expect(rgbToHsl([1, 0, 0])[0]).toBeCloseTo(0)
    expect(rgbToHsl([0, 1, 0])[0]).toBeCloseTo(1 / 3)
    expect(rgbToHsl([0, 0, 1])[0]).toBeCloseTo(2 / 3)
  })
})

describe('hueVariance', () => {
  it('is zero for a single hue', () => {
    expect(hueVariance([[1, 0, 0], [0.5, 0, 0], [0.2, 0, 0]])).toBeCloseTo(0, 5)
  })

  it('is high for hues spread round the wheel', () => {
    expect(hueVariance([[1, 0, 0], [0, 1, 0], [0, 0, 1]])).toBeGreaterThan(0.9)
  })

  it('is zero — not random — for a fully desaturated set', () => {
    // Greys have a numerically defined but meaningless hue; unweighted this
    // would produce noise.
    expect(hueVariance([[0.1, 0.1, 0.1], [0.5, 0.5, 0.5], [0.9, 0.9, 0.9]])).toBe(0)
  })
})

describe('luminanceHistogram', () => {
  it('sums to one', () => {
    const colors: RGB[] = [[0, 0, 0], [0.5, 0.5, 0.5], [1, 1, 1], [0.2, 0.4, 0.1]]
    const sum = luminanceHistogram(colors).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1)
  })

  it('has eight buckets and honours weights', () => {
    const histogram = luminanceHistogram([[0, 0, 0], [1, 1, 1]], [3, 1])
    expect(histogram.length).toBe(8)
    expect(histogram[0]).toBeCloseTo(0.75)
    expect(histogram[7]).toBeCloseTo(0.25)
  })
})

describe('buildPalette', () => {
  it('orders the ramp by luminance', () => {
    const palette = buildPalette('t', 'Test', [
      [1, 1, 1],
      [0, 0, 0],
      [0.5, 0.2, 0.2],
    ])
    for (let i = 1; i < palette.ramp.length; i++) {
      expect(luminance(palette.ramp[i])).toBeGreaterThanOrEqual(luminance(palette.ramp[i - 1]))
    }
  })

  it('picks a saturated accent, not just the brightest colour', () => {
    const palette = buildPalette('t', 'Test', [
      [0.9, 0.9, 0.9], // brightest but grey
      [0.8, 0.1, 0.1], // saturated
      [0.1, 0.1, 0.1],
    ])
    expect(palette.accent).toEqual([0.8, 0.1, 0.1])
  })

  it('gives a background darker than the darkest stop', () => {
    const palette = buildPalette('t', 'Test', [[0.4, 0.4, 0.4], [0.8, 0.8, 0.8]])
    expect(luminance(palette.background)).toBeLessThan(luminance(palette.ramp[0]))
  })

  it('rejects an empty colour set rather than producing a broken palette', () => {
    expect(() => buildPalette('t', 'Test', [])).toThrow()
  })

  it('reports mean saturation', () => {
    const palette = buildPalette('t', 'Test', [[1, 0, 0], [0.5, 0.5, 0.5]])
    expect(palette.meanSaturation).toBeCloseTo(meanSaturation([[1, 0, 0], [0.5, 0.5, 0.5]]))
  })
})

describe('mixPalette', () => {
  const a = BUILT_IN_PALETTES[0]
  const b = BUILT_IN_PALETTES[1]

  it('returns the endpoints exactly at t=0 and t=1', () => {
    expect(mixPalette(a, b, 0).ramp[0]).toEqual(a.ramp[0])
    expect(mixPalette(a, b, 1).ramp[0]).toEqual(b.ramp[0])
  })

  it('clamps out-of-range t', () => {
    expect(mixPalette(a, b, -3).ramp[2]).toEqual(mixPalette(a, b, 0).ramp[2])
    expect(mixPalette(a, b, 9).ramp[2]).toEqual(mixPalette(a, b, 1).ramp[2])
  })

  it('lands between the endpoints in the middle', () => {
    const mid = mixPalette(a, b, 0.5)
    for (let i = 0; i < mid.ramp.length; i++) {
      for (let c = 0; c < 3; c++) {
        const low = Math.min(a.ramp[i][c], b.ramp[i][c])
        const high = Math.max(a.ramp[i][c], b.ramp[i][c])
        expect(mid.ramp[i][c]).toBeGreaterThanOrEqual(low - 1e-6)
        expect(mid.ramp[i][c]).toBeLessThanOrEqual(high + 1e-6)
      }
    }
  })

  it('handles ramps of different lengths without stepping', () => {
    const short = buildPalette('s', 'Short', [[0, 0, 0], [1, 1, 1]])
    const mixed = mixPalette(a, short, 0.5)
    expect(mixed.ramp.length).toBe(Math.max(a.ramp.length, short.ramp.length))
    expect(mixed.ramp.every((c) => c.every((v) => Number.isFinite(v)))).toBe(true)
  })
})

describe('built-in palettes', () => {
  it('all have unique ids', () => {
    const ids = new Set(BUILT_IN_PALETTES.map((p) => p.id))
    expect(ids.size).toBe(BUILT_IN_PALETTES.length)
  })

  it('are all dark-biased — this runs in a room with people in it', () => {
    for (const palette of BUILT_IN_PALETTES) {
      const mean =
        palette.ramp.reduce((sum, color) => sum + luminance(color), 0) / palette.ramp.length
      expect(mean).toBeLessThan(0.55)
      expect(luminance(palette.background)).toBeLessThan(0.1)
    }
  })
})

describe('sampleRamp', () => {
  const palette = BUILT_IN_PALETTES[0]

  it('hits the endpoints', () => {
    expect(sampleRamp(palette, 0)).toEqual(palette.ramp[0])
    expect(sampleRamp(palette, 1)).toEqual(palette.ramp[palette.ramp.length - 1])
  })

  it('clamps out of range input', () => {
    expect(sampleRamp(palette, -1)).toEqual(palette.ramp[0])
    expect(sampleRamp(palette, 2)).toEqual(palette.ramp[palette.ramp.length - 1])
  })

  it('increases monotonically in luminance across a luminance-ordered ramp', () => {
    let previous = -1
    for (let i = 0; i <= 32; i++) {
      const value = luminance(sampleRamp(palette, i / 32))
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6)
      previous = value
    }
  })
})
