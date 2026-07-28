/**
 * Palette picker showing the actual colours.
 *
 * A dropdown listing "Ember, Abyss, Aurora…" asks the user to remember what
 * eight invented names look like, and the only way to find out is to apply
 * each one and wait through a two-second crossfade. Showing the ramp makes the
 * choice visible at a glance, which is the entire job of this control.
 */
import { BUILT_IN_PALETTES } from '../signal/palettes'
import { rgbToHex } from '../signal/color'
import type { Palette } from '../signal/types'

interface PalettePickerProps {
  value: string
  onChange: (id: string) => void
}

export function PalettePicker({ value, onChange }: PalettePickerProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-white/45">Palette</span>
      <div className="grid grid-cols-2 gap-1.5">
        {BUILT_IN_PALETTES.map((palette) => (
          <Swatch
            key={palette.id}
            palette={palette}
            selected={palette.id === value}
            onSelect={() => onChange(palette.id)}
          />
        ))}
      </div>
    </div>
  )
}

function Swatch({
  palette,
  selected,
  onSelect,
}: {
  palette: Palette
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      title={palette.name}
      aria-pressed={selected}
      className={`group flex flex-col gap-1 rounded border p-1 text-left transition ${
        selected
          ? 'border-white/60 bg-white/10'
          : 'border-white/10 hover:border-white/30 hover:bg-white/5'
      }`}
    >
      {/* The ramp itself, as contiguous stops. Rendered from the same Palette
          objects the renderer uses, so what you see is what you get. */}
      <span className="flex h-4 w-full overflow-hidden rounded-sm">
        {palette.ramp.map((color, i) => (
          <span
            key={i}
            className="h-full flex-1"
            style={{ backgroundColor: rgbToHex(color) }}
          />
        ))}
      </span>
      <span
        className={`truncate text-[10px] ${selected ? 'text-white/90' : 'text-white/50'}`}
      >
        {palette.name}
      </span>
    </button>
  )
}
