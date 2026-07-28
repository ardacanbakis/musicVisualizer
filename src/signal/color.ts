/**
 * Colour utilities shared by the built-in palettes and (in phase 5) by the
 * k-means extractor that builds palettes from album art. Both paths go through
 * `buildPalette()` so a Spotify-derived palette and a hand-written one are
 * structurally identical and modes cannot tell them apart.
 */
import type { Palette, RGB } from './types'

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
      : clean
  const value = parseInt(full, 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

export function rgbToHex(rgb: RGB): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`
}

/** Rec. 709 relative luminance. Good enough for ordering a ramp. */
export function luminance(rgb: RGB): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

/** Hue 0..1, saturation 0..1, lightness 0..1. */
export function rgbToHsl(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

/**
 * Circular variance of hue, weighted by saturation.
 *
 * Weighting matters: the hue of a near-grey pixel is numerically defined but
 * perceptually meaningless, and unweighted it drags the variance around at
 * random. 0 = all one hue, 1 = hues spread evenly round the wheel.
 */
export function hueVariance(colors: RGB[]): number {
  let x = 0
  let y = 0
  let weight = 0
  for (const color of colors) {
    const [h, s] = rgbToHsl(color)
    const angle = h * Math.PI * 2
    x += Math.cos(angle) * s
    y += Math.sin(angle) * s
    weight += s
  }
  if (weight <= 1e-6) return 0 // fully desaturated: no hue to vary
  const resultant = Math.hypot(x, y) / weight
  return Math.max(0, Math.min(1, 1 - resultant))
}

export function meanSaturation(colors: RGB[]): number {
  if (colors.length === 0) return 0
  let sum = 0
  for (const color of colors) sum += rgbToHsl(color)[1]
  return sum / colors.length
}

/** 8-bucket normalised luminance histogram, darkest bucket first. */
export function luminanceHistogram(colors: RGB[], weights?: number[]): number[] {
  const buckets = new Array(8).fill(0)
  let total = 0
  colors.forEach((color, i) => {
    const w = weights?.[i] ?? 1
    const bucket = Math.min(7, Math.max(0, Math.floor(luminance(color) * 8)))
    buckets[bucket] += w
    total += w
  })
  if (total <= 0) return buckets
  return buckets.map((b) => b / total)
}

/**
 * Build a complete Palette from a set of source colours.
 *
 * @param weights optional per-colour weight (k-means cluster sizes in phase 5),
 *                so a colour covering half the album art counts for more than a
 *                colour covering 2% of it.
 */
export function buildPalette(
  id: string,
  name: string,
  colors: RGB[],
  weights?: number[],
): Palette {
  if (colors.length === 0) throw new Error(`Palette "${id}" needs at least one colour`)

  const ramp = [...colors].sort((a, b) => luminance(a) - luminance(b))

  // Background: darker than the darkest stop, so there is somewhere for the
  // visuals to sit against. Pure black kills the palette's colour cast.
  const darkest = ramp[0]
  const background: RGB = [darkest[0] * 0.35, darkest[1] * 0.35, darkest[2] * 0.35]

  // Accent: highest chroma, tie-broken towards the brighter option, because a
  // dark saturated accent disappears against the background.
  let accent = ramp[ramp.length - 1]
  let bestScore = -1
  for (const color of colors) {
    const [, s, l] = rgbToHsl(color)
    const score = s * (0.35 + l)
    if (score > bestScore) {
      bestScore = score
      accent = color
    }
  }

  return {
    id,
    name,
    ramp,
    background,
    accent,
    meanSaturation: meanSaturation(colors),
    hueVariance: hueVariance(colors),
    luminanceHistogram: luminanceHistogram(colors, weights),
  }
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * Interpolate between two palettes. Used for the ~2 s crossfade on track
 * change — colour must never hard-cut.
 *
 * Ramps of different lengths are resampled onto the longer of the two, so a
 * 5-colour album palette can cross into an 8-colour built-in without stepping.
 */
export function mixPalette(a: Palette, b: Palette, t: number): Palette {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const length = Math.max(a.ramp.length, b.ramp.length)
  const sample = (palette: Palette, i: number): RGB => {
    const pos = (i / Math.max(1, length - 1)) * (palette.ramp.length - 1)
    const index = Math.min(Math.floor(pos), palette.ramp.length - 2)
    if (palette.ramp.length === 1) return palette.ramp[0]
    return mixRgb(palette.ramp[index], palette.ramp[index + 1], pos - index)
  }

  const ramp: RGB[] = []
  for (let i = 0; i < length; i++) ramp.push(mixRgb(sample(a, i), sample(b, i), clamped))

  const lerp = (x: number, y: number) => x + (y - x) * clamped
  return {
    id: clamped >= 1 ? b.id : a.id,
    name: clamped >= 0.5 ? b.name : a.name,
    ramp,
    background: mixRgb(a.background, b.background, clamped),
    accent: mixRgb(a.accent, b.accent, clamped),
    meanSaturation: lerp(a.meanSaturation, b.meanSaturation),
    hueVariance: lerp(a.hueVariance, b.hueVariance),
    luminanceHistogram: a.luminanceHistogram.map((v, i) =>
      lerp(v, b.luminanceHistogram[i] ?? v),
    ),
  }
}
