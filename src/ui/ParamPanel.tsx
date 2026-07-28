/**
 * The settings panel, generated entirely from a mode's `ParamSchema`.
 *
 * No mode ever hand-writes a control. Adding a param to a mode means adding a
 * line to its schema; this renders it, persists it, and resets it. That is the
 * whole reason the schema is declarative — a bespoke panel per mode is six
 * panels to keep in sync by the time the mode list is finished.
 *
 * Adding a new *control type* means adding a case here and a variant to
 * ParamDef. That is the only place types and controls need to agree.
 */
import type { ParamDef, ParamSchema, ParamValue, ParamValues } from '../render/types'

interface ParamPanelProps {
  schema: ParamSchema
  values: ParamValues
  onChange: (key: string, value: ParamValue) => void
  onReset: () => void
}

const UNGROUPED = ''

export function ParamPanel({ schema, values, onChange, onReset }: ParamPanelProps) {
  const keys = Object.keys(schema)
  if (keys.length === 0) return null

  // Preserve schema declaration order within each group; groups appear in the
  // order their first param does, so a mode author controls layout by ordering
  // the schema rather than by fighting the panel.
  const groups = new Map<string, string[]>()
  for (const key of keys) {
    const group = schema[key].group ?? UNGROUPED
    const existing = groups.get(group)
    if (existing) existing.push(key)
    else groups.set(group, [key])
  }

  return (
    <div className="flex flex-col gap-3">
      {[...groups.entries()].map(([group, groupKeys]) => (
        <div key={group || 'default'} className="flex flex-col gap-2.5">
          {group !== UNGROUPED && (
            <span className="text-[10px] uppercase tracking-wider text-white/35">
              {group}
            </span>
          )}
          {groupKeys.map((key) => (
            <Control
              key={key}
              name={key}
              def={schema[key]}
              value={values[key]}
              onChange={onChange}
            />
          ))}
        </div>
      ))}

      <button
        onClick={onReset}
        className="mt-1 self-start text-xs text-white/40 underline underline-offset-2 hover:text-white/70"
      >
        Reset to defaults
      </button>
    </div>
  )
}

interface ControlProps {
  name: string
  def: ParamDef
  value: ParamValue | undefined
  onChange: (key: string, value: ParamValue) => void
}

function Control({ name, def, value, onChange }: ControlProps) {
  const label = (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-white/70">{def.label}</span>
      {(def.type === 'float' || def.type === 'int') && (
        <span className="font-mono text-[10px] tabular-nums text-white/40">
          {formatNumber(Number(value ?? def.default), def.type)}
        </span>
      )}
    </div>
  )

  const hint = def.hint && (
    <span className="text-[10px] leading-snug text-white/30">{def.hint}</span>
  )

  switch (def.type) {
    case 'float':
    case 'int': {
      const step = def.step ?? (def.type === 'int' ? 1 : 0.01)
      return (
        <label className="flex flex-col gap-1">
          {label}
          <input
            type="range"
            min={def.min}
            max={def.max}
            step={step}
            value={Number(value ?? def.default)}
            onChange={(e) => {
              const next = Number(e.target.value)
              onChange(name, def.type === 'int' ? Math.round(next) : next)
            }}
            className="h-1 w-full cursor-pointer appearance-none rounded bg-white/15 accent-white/80"
          />
          {hint}
        </label>
      )
    }

    case 'bool':
      return (
        <label className="flex cursor-pointer flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-white/70">{def.label}</span>
            <input
              type="checkbox"
              checked={Boolean(value ?? def.default)}
              onChange={(e) => onChange(name, e.target.checked)}
              className="h-3.5 w-3.5 accent-white/80"
            />
          </div>
          {hint}
        </label>
      )

    case 'enum':
      return (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-white/70">{def.label}</span>
          <select
            value={String(value ?? def.default)}
            onChange={(e) => onChange(name, e.target.value)}
            className="rounded border border-white/15 bg-black/60 px-2 py-1 text-xs"
          >
            {def.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {hint}
        </label>
      )

    case 'color':
      return (
        <label className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-white/70">{def.label}</span>
            <input
              type="color"
              value={String(value ?? def.default)}
              onChange={(e) => onChange(name, e.target.value)}
              className="h-5 w-8 cursor-pointer rounded border border-white/15 bg-transparent"
            />
          </div>
          {hint}
        </label>
      )
  }
}

/** Enough precision to be useful, not so much that the number jitters. */
function formatNumber(value: number, type: 'float' | 'int'): string {
  if (type === 'int') return String(Math.round(value))
  if (Math.abs(value) >= 100) return value.toFixed(0)
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2)
}
