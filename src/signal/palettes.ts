/**
 * Built-in palettes — the no-Spotify path.
 *
 * All of these are dark-biased on purpose. The primary use is a screen running
 * unattended in a room where people are doing other things; a palette with a
 * bright mean is a lamp, not a visual.
 */
import { buildPalette } from './color'
import { hexToRgb } from './color'
import type { Palette } from './types'

interface PaletteSeed {
  id: string
  name: string
  colors: string[]
}

const SEEDS: PaletteSeed[] = [
  {
    id: 'ember',
    name: 'Ember',
    colors: ['#1a0b06', '#3d1408', '#7a2410', '#b8420f', '#e0701a', '#f2a23c', '#ffd08a', '#fff0d6'],
  },
  {
    id: 'abyss',
    name: 'Abyss',
    colors: ['#03060f', '#071a2e', '#0b3352', '#0f5273', '#12798c', '#2aa39c', '#7fd4c1', '#d8f5ec'],
  },
  {
    id: 'aurora',
    name: 'Aurora',
    colors: ['#04070d', '#0a1f2b', '#0e4a45', '#177a52', '#3fb06a', '#84d99a', '#c2f0d0', '#eafaf1'],
  },
  {
    id: 'monolith',
    name: 'Monolith',
    colors: ['#050506', '#141518', '#26282d', '#3d4046', '#5a5e66', '#828790', '#b4b9c1', '#e8eaee'],
  },
  {
    id: 'nocturne',
    name: 'Nocturne',
    colors: ['#06040f', '#150b2e', '#2a134f', '#45206b', '#6534a0', '#8f5fd4', '#bb9bea', '#e6dcfa'],
  },
  {
    id: 'sakura',
    name: 'Sakura',
    colors: ['#150a10', '#301524', '#57243c', '#8a3a58', '#c25f7c', '#e58fa5', '#f5bfcc', '#fdeaf0'],
  },
  {
    id: 'copper',
    name: 'Copper',
    colors: ['#0d0a08', '#241a12', '#45301d', '#6d4a26', '#9c6d33', '#c79553', '#e5c087', '#f7e6c9'],
  },
  {
    id: 'moss',
    name: 'Moss',
    colors: ['#080a06', '#161d10', '#28351b', '#3f5228', '#5c7538', '#86a052', '#b6c882', '#e2ebc5'],
  },
]

export const BUILT_IN_PALETTES: Palette[] = SEEDS.map((seed) =>
  buildPalette(seed.id, seed.name, seed.colors.map(hexToRgb)),
)

export const DEFAULT_PALETTE: Palette = BUILT_IN_PALETTES[0]

export function paletteById(id: string): Palette {
  return BUILT_IN_PALETTES.find((p) => p.id === id) ?? DEFAULT_PALETTE
}

/** The palette `delta` places along from `id`, wrapping. */
export function cyclePaletteId(id: string, delta: number): string {
  const index = BUILT_IN_PALETTES.findIndex((p) => p.id === id)
  const from = index === -1 ? 0 : index
  const count = BUILT_IN_PALETTES.length
  return BUILT_IN_PALETTES[(from + delta + count * 2) % count].id
}

export function randomPalette(exclude?: string): Palette {
  const options = BUILT_IN_PALETTES.filter((p) => p.id !== exclude)
  const pool = options.length > 0 ? options : BUILT_IN_PALETTES
  return pool[Math.floor(Math.random() * pool.length)]
}
