/**
 * The mode registry.
 *
 * Adding a mode is: write the file, add one import, add one entry to FACTORIES.
 * Nothing else in the app should ever need to know a mode's name.
 *
 * Mode constructors must be free of side effects — the registry instantiates a
 * throwaway probe to read each mode's metadata without touching the GPU. All
 * GPU work belongs in `init()`.
 */
import { createBarsMode } from './modes/bars'
import { createFlowFieldMode } from './modes/flowField'
import type { ParamSchema, VisualMode, VisualModeFactory } from './types'

const FACTORIES: VisualModeFactory[] = [
  createFlowFieldMode,
  createBarsMode,
  // Phase 4: reaction-diffusion, geometric tiling, 3D terrain
  // Phase 4: fireplace, lava lamp
]

export interface ModeEntry {
  id: string
  name: string
  description: string
  params: ParamSchema
  create: VisualModeFactory
}

export const MODES: ModeEntry[] = FACTORIES.map((create) => {
  const probe = create()
  return {
    id: probe.id,
    name: probe.name,
    description: probe.description,
    params: probe.params,
    create,
  }
})

const byId = new Map(MODES.map((entry) => [entry.id, entry]))
if (byId.size !== MODES.length) {
  // Ids are persisted to localStorage, so a collision silently swaps which mode
  // a user gets back on reload. Fail loudly at import time instead.
  throw new Error('Duplicate visual mode id in registry')
}

export const DEFAULT_MODE_ID = MODES[0].id

export function modeEntry(id: string): ModeEntry {
  return byId.get(id) ?? MODES[0]
}

/** Create a fresh, uninitialised instance of a mode. Caller must call init(). */
export function createMode(id: string): VisualMode {
  return modeEntry(id).create()
}
