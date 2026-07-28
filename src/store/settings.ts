/**
 * Persisted settings. Everything here survives a reload; nothing here is
 * per-frame state (that lives in the bus and the modes).
 *
 * Params are stored per mode id and merged over the schema defaults on read,
 * so adding a new param to an existing mode does not break saved settings.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_MODE_ID } from '../render/registry'
import type { ParamValue, ParamValues } from '../render/types'
import { DEFAULT_PALETTE } from '../signal/palettes'

interface SettingsState {
  modeId: string
  paletteId: string
  /** Sparse: only params the user has actually changed. */
  params: Record<string, ParamValues>
  debugVisible: boolean
  /** Whether the settings panel is shown. Persisted: a wall display should
   *  come back up bare after a power cut, not with the controls open. */
  panelVisible: boolean

  /** Auto-rotate. Mode and palette are separate because wanting one colour
   *  scheme with changing visuals (or the reverse) are both reasonable. */
  rotateModes: boolean
  rotatePalettes: boolean
  /** Seconds between rotations. */
  rotateSeconds: number

  setMode: (id: string) => void
  setPalette: (id: string) => void
  setParam: (modeId: string, key: string, value: ParamValue) => void
  resetParams: (modeId: string) => void
  toggleDebug: () => void
  togglePanel: () => void
  setRotateModes: (on: boolean) => void
  setRotatePalettes: (on: boolean) => void
  setRotateSeconds: (seconds: number) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      modeId: DEFAULT_MODE_ID,
      paletteId: DEFAULT_PALETTE.id,
      params: {},
      debugVisible: false,
      panelVisible: true,
      rotateModes: false,
      rotatePalettes: false,
      rotateSeconds: 180,

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
      togglePanel: () => set((state) => ({ panelVisible: !state.panelVisible })),
      setRotateModes: (on) => set({ rotateModes: on }),
      setRotatePalettes: (on) => set({ rotatePalettes: on }),
      setRotateSeconds: (seconds) =>
        set({ rotateSeconds: Math.max(15, Math.round(seconds)) }),
    }),
    {
      name: 'ambient-visualizer-settings',
      version: 1,
    },
  ),
)

// Re-exported so callers have one obvious import for "settings things".
// The logic itself lives in render/params.ts, free of the store.
export { resolveParams } from '../render/params'
