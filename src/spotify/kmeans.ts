/**
 * k-means colour quantisation, deterministic by construction.
 *
 * Determinism is a requirement, not a nicety: the same album art must produce
 * the same palette every time, or a track you have heard before comes back
 * looking different and the app feels unreliable. Two things guarantee it —
 * a seeded PRNG for initialisation, and a fixed iteration count rather than a
 * convergence threshold (which can land on either side of the epsilon
 * depending on floating-point ordering).
 *
 * Initialisation is k-means++ rather than uniform random. Uniform picks
 * occasionally seed two centroids inside the same dominant colour, leaving a
 * whole region of the image unrepresented and producing a palette missing its
 * most striking colour. k-means++ spreads the seeds by construction.
 *
 * Distance is computed in a rough perceptual space, not raw RGB: RGB distance
 * treats a dark blue and a dark green as far apart while calling two bright
 * yellows neighbours, which is the opposite of how the eye groups them.
 *
 * Pure — no DOM, no canvas. The worker wraps it; the tests call it directly.
 */

export interface Cluster {
  /** Centroid colour, sRGB 0..1. */
  color: [number, number, number]
  /** Fraction of sampled pixels in this cluster, 0..1. */
  weight: number
}

/**
 * Mulberry32. Small, fast, and — the only property that matters here —
 * identical across engines for a given seed.
 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Weighted squared distance. Green is weighted most heavily because luminance
 * is mostly green, so this keeps clusters from merging across brightness.
 */
function distanceSquared(
  ar: number,
  ag: number,
  ab: number,
  br: number,
  bg: number,
  bb: number,
): number {
  const dr = (ar - br) * 0.9
  const dg = (ag - bg) * 1.6
  const db = (ab - bb) * 0.7
  return dr * dr + dg * dg + db * db
}

export interface KMeansOptions {
  k?: number
  iterations?: number
  seed?: number
  /**
   * Pixels darker than this are dropped before clustering. Album art is
   * frequently half black background, which otherwise wins several clusters
   * and yields a palette of four nearly identical near-blacks.
   */
  minLuminance?: number
}

/**
 * @param pixels RGBA bytes, as from `ImageData.data`. Alpha is ignored except
 *               that fully transparent pixels are skipped.
 */
export function kmeans(pixels: Uint8ClampedArray | Uint8Array, options: KMeansOptions = {}): Cluster[] {
  const k = options.k ?? 8
  const iterations = options.iterations ?? 12
  const seed = options.seed ?? 0x5eed
  const minLuminance = options.minLuminance ?? 0.06

  // --- gather usable samples ---
  const sampleR: number[] = []
  const sampleG: number[] = []
  const sampleB: number[] = []
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue
    const r = pixels[i] / 255
    const g = pixels[i + 1] / 255
    const b = pixels[i + 2] / 255
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < minLuminance) continue
    sampleR.push(r)
    sampleG.push(g)
    sampleB.push(b)
  }

  const count = sampleR.length
  if (count === 0) return []
  const effectiveK = Math.min(k, count)

  const random = makeRandom(seed)

  // --- k-means++ seeding ---
  const centroidR = new Float64Array(effectiveK)
  const centroidG = new Float64Array(effectiveK)
  const centroidB = new Float64Array(effectiveK)

  const first = Math.floor(random() * count)
  centroidR[0] = sampleR[first]
  centroidG[0] = sampleG[first]
  centroidB[0] = sampleB[first]

  const nearest = new Float64Array(count).fill(Infinity)
  for (let c = 1; c < effectiveK; c++) {
    let total = 0
    for (let i = 0; i < count; i++) {
      const d = distanceSquared(
        sampleR[i], sampleG[i], sampleB[i],
        centroidR[c - 1], centroidG[c - 1], centroidB[c - 1],
      )
      if (d < nearest[i]) nearest[i] = d
      total += nearest[i]
    }
    // Choose the next centroid with probability proportional to its distance
    // from the nearest existing one.
    let target = random() * total
    let chosen = count - 1
    for (let i = 0; i < count; i++) {
      target -= nearest[i]
      if (target <= 0) {
        chosen = i
        break
      }
    }
    centroidR[c] = sampleR[chosen]
    centroidG[c] = sampleG[chosen]
    centroidB[c] = sampleB[chosen]
  }

  // --- Lloyd iterations ---
  const assignment = new Int32Array(count)
  const sumR = new Float64Array(effectiveK)
  const sumG = new Float64Array(effectiveK)
  const sumB = new Float64Array(effectiveK)
  const members = new Int32Array(effectiveK)

  for (let iteration = 0; iteration < iterations; iteration++) {
    sumR.fill(0)
    sumG.fill(0)
    sumB.fill(0)
    members.fill(0)

    for (let i = 0; i < count; i++) {
      let best = 0
      let bestDistance = Infinity
      for (let c = 0; c < effectiveK; c++) {
        const d = distanceSquared(
          sampleR[i], sampleG[i], sampleB[i],
          centroidR[c], centroidG[c], centroidB[c],
        )
        if (d < bestDistance) {
          bestDistance = d
          best = c
        }
      }
      assignment[i] = best
      sumR[best] += sampleR[i]
      sumG[best] += sampleG[i]
      sumB[best] += sampleB[i]
      members[best]++
    }

    for (let c = 0; c < effectiveK; c++) {
      // An emptied cluster keeps its previous centroid rather than being
      // re-seeded randomly, which would break determinism.
      if (members[c] === 0) continue
      centroidR[c] = sumR[c] / members[c]
      centroidG[c] = sumG[c] / members[c]
      centroidB[c] = sumB[c] / members[c]
    }
  }

  const clusters: Cluster[] = []
  for (let c = 0; c < effectiveK; c++) {
    if (members[c] === 0) continue
    clusters.push({
      color: [centroidR[c], centroidG[c], centroidB[c]],
      weight: members[c] / count,
    })
  }

  // Sorted by weight so callers can take the dominant colours first. Ties are
  // broken by colour so the order is fully determined, not left to the sort's
  // stability guarantees.
  clusters.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight
    return a.color[0] + a.color[1] + a.color[2] - (b.color[0] + b.color[1] + b.color[2])
  })
  return clusters
}
