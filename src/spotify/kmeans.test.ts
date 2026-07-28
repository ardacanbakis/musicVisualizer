import { describe, expect, it } from 'vitest'
import { kmeans } from './kmeans'

/** Build an RGBA buffer from a list of colours, each repeated `repeat` times. */
function pixelsFrom(colors: [number, number, number][], repeat = 50): Uint8ClampedArray {
  const data = new Uint8ClampedArray(colors.length * repeat * 4)
  let offset = 0
  for (const [r, g, b] of colors) {
    for (let i = 0; i < repeat; i++) {
      data[offset++] = r
      data[offset++] = g
      data[offset++] = b
      data[offset++] = 255
    }
  }
  return data
}

/** Deterministic pseudo-random image, so tests do not depend on Math.random. */
function noiseImage(pixelCount: number, seed = 1): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixelCount * 4)
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  for (let i = 0; i < pixelCount; i++) {
    data[i * 4] = Math.floor(next() * 256)
    data[i * 4 + 1] = Math.floor(next() * 256)
    data[i * 4 + 2] = Math.floor(next() * 256)
    data[i * 4 + 3] = 255
  }
  return data
}

describe('kmeans determinism', () => {
  it('gives byte-identical results across runs with the same seed', () => {
    // The headline requirement: the same album art must always produce the
    // same palette, or a track you have heard before comes back looking
    // different and the whole thing feels unreliable.
    const pixels = noiseImage(2000)
    const a = kmeans(pixels, { seed: 42 })
    const b = kmeans(pixels, { seed: 42 })
    expect(a).toEqual(b)
  })

  it('is stable over many repeats, not just twice', () => {
    const pixels = noiseImage(1200, 7)
    const reference = JSON.stringify(kmeans(pixels, { seed: 9 }))
    for (let i = 0; i < 8; i++) {
      expect(JSON.stringify(kmeans(pixels, { seed: 9 }))).toBe(reference)
    }
  })

  it('gives different results for different seeds', () => {
    // If the seed did nothing, the determinism test above would be vacuous.
    const pixels = noiseImage(2000)
    const a = kmeans(pixels, { seed: 1 })
    const b = kmeans(pixels, { seed: 99999 })
    expect(a).not.toEqual(b)
  })
})

describe('kmeans clustering', () => {
  it('recovers well-separated colours', () => {
    const pixels = pixelsFrom([
      [230, 30, 30],
      [30, 220, 40],
      [40, 50, 240],
    ])
    const clusters = kmeans(pixels, { k: 3 })
    expect(clusters.length).toBe(3)

    // Each input colour should have a centroid essentially on top of it.
    for (const [r, g, b] of [
      [230 / 255, 30 / 255, 30 / 255],
      [30 / 255, 220 / 255, 40 / 255],
      [40 / 255, 50 / 255, 240 / 255],
    ]) {
      const match = clusters.find(
        (c) =>
          Math.abs(c.color[0] - r) < 0.02 &&
          Math.abs(c.color[1] - g) < 0.02 &&
          Math.abs(c.color[2] - b) < 0.02,
      )
      expect(match, `no centroid near ${r},${g},${b}`).toBeTruthy()
    }
  })

  it('weights clusters by how much of the image they cover', () => {
    const dominant = pixelsFrom([[220, 40, 40]], 300)
    const minor = pixelsFrom([[40, 40, 220]], 30)
    const combined = new Uint8ClampedArray(dominant.length + minor.length)
    combined.set(dominant, 0)
    combined.set(minor, dominant.length)

    const clusters = kmeans(combined, { k: 2 })
    expect(clusters[0].weight).toBeGreaterThan(clusters[1].weight)
    expect(clusters[0].color[0]).toBeGreaterThan(clusters[0].color[2])
  })

  it('weights sum to one', () => {
    const clusters = kmeans(noiseImage(900, 3))
    const total = clusters.reduce((sum, c) => sum + c.weight, 0)
    expect(total).toBeCloseTo(1, 6)
  })

  it('is sorted by descending weight', () => {
    const clusters = kmeans(noiseImage(1500, 11))
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1].weight).toBeGreaterThanOrEqual(clusters[i].weight)
    }
  })
})

describe('kmeans edge cases', () => {
  it('returns nothing for an entirely transparent image', () => {
    expect(kmeans(new Uint8ClampedArray(400)).length).toBe(0)
  })

  it('returns nothing for an all-black image rather than a palette of blacks', () => {
    // Album art is often half black background. Without the luminance floor
    // those pixels win several clusters and the palette becomes four
    // indistinguishable near-blacks.
    expect(kmeans(pixelsFrom([[0, 0, 0]], 200)).length).toBe(0)
  })

  it('does not spend clusters on a dark background', () => {
    const art = new Uint8ClampedArray(
      [...pixelsFrom([[4, 4, 6]], 800), ...pixelsFrom([[240, 120, 30]], 100)],
    )
    const clusters = kmeans(art, { k: 4 })
    expect(clusters.length).toBeGreaterThan(0)
    // Every surviving cluster should be the bright colour, not the background.
    for (const cluster of clusters) {
      expect(cluster.color[0]).toBeGreaterThan(0.5)
    }
  })

  it('handles fewer distinct pixels than k without crashing', () => {
    const clusters = kmeans(pixelsFrom([[200, 100, 50]], 3), { k: 8 })
    expect(clusters.length).toBeGreaterThan(0)
    expect(clusters.length).toBeLessThanOrEqual(3)
  })

  it('produces colours inside the valid range', () => {
    for (const cluster of kmeans(noiseImage(1000, 5))) {
      for (const channel of cluster.color) {
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(1)
      }
    }
  })
})
