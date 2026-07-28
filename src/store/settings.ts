/**
 * Persisted settings. Everything here survives a reload; nothing here is
 * per-frame state (that lives in the bus and the modes).
 *
 * Params are stored per mode id and merged over the schema defaults on read,
 * so adding a new param to an existing mode does not break saved settings.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_MODE_ID, modeEntry } from '../render/registry'
import { defaultParams } from '../render/types'
import type { ParamValue, ParamValues } from '../render/types'
import { DEFAULT_PALETTE } from '../signal/palettes'

interface SettingsState {
  modeId: string
  paletteId: string
  /** Sparse: only params the user has actually changed. */
  params: Record<string, ParamValues>
  debugVisible: boolean

  setMode: (id: string) => void
  setPalette: (id: string) => void
  setParam: (modeId: string, key: string, value: ParamValue) => void
  resetParams: (modeId: string) => void
  toggleDebug: () => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      modeId: DEFAULT_MODE_ID,
      paletteId: DEFAULT_PALETTE.id,
      params: {},
      debugVisible: false,

      setMode: (id) => set({ modeId: id }),
      setPalette: (id) => set({ paletteId: id }),
      setParam: (modeId, key, value) =>
        set((state) => ({
          params: {
            ...state.params,
            [modeId]: { ...(state.params[modeId] ?? {}), [key]: value },
          },
        })),
      resetParams: (modeId) =>
        set((state) => {
          const next = { ...state.params }
          delete next[modeId]
          return { params: next }
        }),
      toggleDebug: () => set((state) => ({ debugVisible: !state.debugVisible })),
    }),
    {
      name: 'ambient-visualizer-settings',
      version: 1,
    },
  ),
)

/** Schema defaults with any saved overrides applied on top. */
export function resolveParams(modeId: string, saved: Record<string, ParamValues>): ParamValues {
  const schema = modeEntry(modeId).params
  const defaults = defaultParams(schema)
  const overrides = saved[modeId]
  if (!overrides) return defaults
  const merged: ParamValues = { ...defaults }
  for (const key of Object.keys(overrides)) {
    // Ignore stored keys the schema no longer has — otherwise a renamed param
    // leaves dead values in localStorage forever.
    if (key in schema) merged[key] = overrides[key]
  }
  return merged
}
