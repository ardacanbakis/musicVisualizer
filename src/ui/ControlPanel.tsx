/**
 * The control panel.
 *
 * Extracted out of App so App owns the render loop and nothing else. Two
 * placements, left or right, chosen by the dock button in the header — a wall
 * display's furniture is usually on one particular side of the room, and the
 * panel should be able to sit away from it.
 *
 * Layout decisions worth keeping:
 *
 * - **Sections collapse.** With eight modes and up to ten params each, the
 *   panel was taller than the viewport and every visit began with a scroll.
 *   Collapsed state is per-section and persisted.
 * - **Modes are a labelled list, not a `<select>`.** A dropdown hides seven of
 *   eight options behind a click and shows none of their descriptions, which
 *   is the same mistake the palette dropdown was making.
 * - **Nothing in here is bright.** Highest-contrast element is the selected
 *   mode's border. This lives on a wall in a dark room.
 */
import { useState } from 'react'
import { MODES } from '../render/registry'
import type { ParamSchema, ParamValue, ParamValues } from '../render/types'
import { ParamPanel } from './ParamPanel'
import { PalettePicker } from './PalettePicker'
import {
  ChevronIcon,
  CloseIcon,
  DockLeftIcon,
  DockRightIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
} from './icons'

export type Dock = 'left' | 'right'

interface ControlPanelProps {
  dock: Dock
  onToggleDock: () => void
  onClose: () => void
  fullscreen: { isFullscreen: boolean; supported: boolean; toggle: () => void }

  micState: 'off' | 'requesting' | 'on' | 'denied' | 'unsupported'
  sourceLabel: string
  onEnableMic: () => void
  onDisableMic: () => void

  modeId: string
  onSelectMode: (id: string) => void
  paletteId: string
  onSelectPalette: (id: string) => void

  schema: ParamSchema
  params: ParamValues
  onParamChange: (key: string, value: ParamValue) => void
  onParamReset: () => void

  rotateModes: boolean
  rotatePalettes: boolean
  rotateSeconds: number
  onRotateModes: (on: boolean) => void
  onRotatePalettes: (on: boolean) => void
  onRotateSeconds: (seconds: number) => void

  spotify: React.ReactNode
}

export function ControlPanel(props: ControlPanelProps) {
  const { dock, fullscreen } = props

  return (
    <div
      className={`pointer-events-auto flex max-h-full w-[17rem] flex-col overflow-hidden rounded-xl border border-white/10 bg-black/70 text-sm text-white/85 shadow-2xl shadow-black/50 backdrop-blur-md ${
        dock === 'right' ? 'ml-auto' : ''
      }`}
    >
      {/* Header stays put while the body scrolls — the close and dock buttons
          should never be scrolled off. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            props.micState === 'on' ? 'bg-emerald-400' : 'bg-white/30'
          }`}
        />
        <span className="truncate font-mono text-[10px] uppercase tracking-widest text-white/50">
          {props.sourceLabel}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            onClick={props.onToggleDock}
            title={dock === 'left' ? 'Dock right' : 'Dock left'}
          >
            {dock === 'left' ? <DockRightIcon /> : <DockLeftIcon />}
          </IconButton>
          {fullscreen.supported && (
            <IconButton
              onClick={fullscreen.toggle}
              title={fullscreen.isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
            >
              {fullscreen.isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </IconButton>
          )}
          <IconButton onClick={props.onClose} title="Hide settings (H)">
            <CloseIcon />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto px-3 py-3">
        {props.micState === 'on' ? (
          <button
            onClick={props.onDisableMic}
            className="rounded-lg border border-white/15 px-3 py-2 text-left text-xs transition hover:bg-white/10"
          >
            Disconnect microphone
          </button>
        ) : (
          <button
            onClick={props.onEnableMic}
            disabled={props.micState === 'requesting'}
            className="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-left text-xs text-emerald-100/90 transition hover:bg-emerald-400/20 disabled:opacity-50"
          >
            {props.micState === 'requesting' ? 'Requesting…' : 'Enable microphone'}
          </button>
        )}
        {props.micState === 'denied' && (
          <p className="text-[11px] leading-snug text-white/40">
            No microphone access. Running on synthetic audio — everything still works.
          </p>
        )}
        {props.micState === 'unsupported' && (
          <p className="text-[11px] leading-snug text-white/40">
            No microphone API here. Needs https or localhost.
          </p>
        )}

        <Section id="mode" title="Mode" defaultOpen>
          <div className="flex flex-col gap-1">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => props.onSelectMode(mode.id)}
                title={mode.description}
                className={`rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                  mode.id === props.modeId
                    ? 'border-white/50 bg-white/10 text-white'
                    : 'border-transparent text-white/55 hover:border-white/15 hover:bg-white/5 hover:text-white/85'
                }`}
              >
                {mode.name}
              </button>
            ))}
          </div>
        </Section>

        <Section id="palette" title="Palette" defaultOpen>
          <PalettePicker value={props.paletteId} onChange={props.onSelectPalette} />
        </Section>

        <Section id="params" title="Mode settings" defaultOpen>
          <ParamPanel
            schema={props.schema}
            values={props.params}
            onChange={props.onParamChange}
            onReset={props.onParamReset}
          />
        </Section>

        <Section id="rotate" title="Auto-rotate">
          <div className="flex flex-col gap-2">
            <Toggle
              label="Shuffle modes"
              checked={props.rotateModes}
              onChange={props.onRotateModes}
            />
            <Toggle
              label="Shuffle palettes"
              checked={props.rotatePalettes}
              onChange={props.onRotatePalettes}
            />
            <label className="flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-2 text-xs text-white/70">
                Every
                <span className="font-mono text-[10px] tabular-nums text-white/40">
                  {formatInterval(props.rotateSeconds)}
                </span>
              </span>
              <input
                type="range"
                min={15}
                max={1800}
                step={15}
                value={props.rotateSeconds}
                onChange={(e) => props.onRotateSeconds(Number(e.target.value))}
                className="h-1 w-full cursor-pointer appearance-none rounded bg-white/15 accent-white/80"
              />
            </label>
          </div>
        </Section>

        <Section id="spotify" title="Spotify">{props.spotify}</Section>

        <Section id="shortcuts" title="Shortcuts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-white/40">
            <Shortcut keys="C / ⇧C" label="Next / previous palette" />
            <Shortcut keys="S / ⇧S" label="Next / previous mode" />
            <Shortcut keys="1…9" label="Jump to mode" />
            <Shortcut keys="F" label="Fullscreen" />
            <Shortcut keys="H" label="Hide this panel" />
            <Shortcut keys="D" label="Debug scope" />
          </dl>
        </Section>
      </div>
    </div>
  )
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <>
      <dt className="font-mono text-white/60">{keys}</dt>
      <dd>{label}</dd>
    </>
  )
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded-md p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white/90"
    >
      {children}
    </button>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2">
      <span className="text-xs text-white/70">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-white/80"
      />
    </label>
  )
}

/**
 * Collapsible section. Open state is local and remembered in sessionStorage
 * rather than the settings store: it is a view preference, not a setting, and
 * it should not be part of what a user exports or resets.
 */
function Section({
  id,
  title,
  defaultOpen = false,
  children,
}: {
  id: string
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const storageKey = `amb-section-${id}`
  const [open, setOpen] = useState(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      return saved === null ? defaultOpen : saved === '1'
    } catch {
      // Private-mode Safari throws on sessionStorage. Not worth failing over.
      return defaultOpen
    }
  })

  const toggle = () => {
    setOpen((was) => {
      const next = !was
      try {
        sessionStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <div className="rounded-lg border border-white/10">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition hover:bg-white/5"
      >
        <span
          className={`text-white/35 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <ChevronIcon />
        </span>
        <span className="text-[10px] uppercase tracking-widest text-white/45">{title}</span>
      </button>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
    </div>
  )
}

/** "3m" reads better than "180s" for a rotation interval. */
function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = seconds / 60
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`
}
