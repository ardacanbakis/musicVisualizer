/**
 * Compact menu — the alternative to the sidebar.
 *
 * A horizontal strip along the bottom rather than a panel down one side. This
 * is not the sidebar moved: it is a different set of controls chosen for a
 * different situation. The sidebar is for setting the thing up; this is for
 * driving it once it is running, so it carries only what you reach for while
 * watching — mode, palette, and the window controls — and gives the visual
 * back almost the whole screen.
 *
 * Anything deeper (per-mode parameters, Spotify setup, auto-rotate) is
 * deliberately absent. Switch back to the sidebar for those; duplicating them
 * here would just make two panels to keep in sync.
 */
import { BUILT_IN_PALETTES } from '../signal/palettes'
import { rgbToHex } from '../signal/color'
import { MODES } from '../render/registry'
import {
  CameraIcon,
  ChevronIcon,
  CloseIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  SidebarIcon,
} from './icons'

interface CompactBarProps {
  micState: 'off' | 'requesting' | 'on' | 'denied' | 'unsupported'
  modeId: string
  onSelectMode: (id: string) => void
  paletteId: string
  onSelectPalette: (id: string) => void
  onSwitchLayout: () => void
  onClose: () => void
  fullscreen: { isFullscreen: boolean; supported: boolean; toggle: () => void }
  /** 1x only here — see the sidebar for high-resolution exports. */
  capturing: boolean
  onCapture: () => void
}

export function CompactBar(props: CompactBarProps) {
  const index = Math.max(0, MODES.findIndex((m) => m.id === props.modeId))
  const step = (delta: number) => {
    const next = (index + delta + MODES.length) % MODES.length
    props.onSelectMode(MODES[next].id)
  }

  return (
    <div className="pointer-events-auto flex max-w-[min(46rem,calc(100vw-2rem))] items-center gap-3 overflow-x-auto rounded-full border border-white/10 bg-black/70 px-3 py-2 shadow-2xl shadow-black/50 backdrop-blur-md">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          props.micState === 'on' ? 'bg-emerald-400' : 'bg-white/25'
        }`}
        title={props.micState === 'on' ? 'Microphone' : 'Synthetic audio'}
      />

      {/* Mode stepper. The name is the widest thing here, so it gets a fixed
          width — otherwise the whole bar reflows on every mode change. */}
      <div className="flex shrink-0 items-center gap-1">
        <RoundButton onClick={() => step(-1)} title="Previous mode (⇧S)">
          <span className="block rotate-180">
            <ChevronIcon />
          </span>
        </RoundButton>
        <span className="w-[8.5rem] truncate text-center text-xs text-white/80">
          {MODES[index].name}
        </span>
        <RoundButton onClick={() => step(1)} title="Next mode (S)">
          <ChevronIcon />
        </RoundButton>
      </div>

      <span className="h-5 w-px shrink-0 bg-white/10" />

      {/* Palettes as their own colours, same reasoning as the sidebar picker:
          you choose these by sight, not by name. */}
      <div className="flex shrink-0 items-center gap-1">
        {BUILT_IN_PALETTES.map((palette) => (
          <button
            key={palette.id}
            onClick={() => props.onSelectPalette(palette.id)}
            title={palette.name}
            aria-label={palette.name}
            aria-pressed={palette.id === props.paletteId}
            className={`flex h-5 w-8 overflow-hidden rounded border transition ${
              palette.id === props.paletteId
                ? 'border-white/70'
                : 'border-white/10 opacity-55 hover:opacity-100'
            }`}
          >
            {/* Four stops is enough to identify a palette at this size; all
                eight would be one-pixel slivers. */}
            {[2, 4, 5, 7].map((stop) => (
              <span
                key={stop}
                className="h-full flex-1"
                style={{
                  backgroundColor: rgbToHex(
                    palette.ramp[Math.min(stop, palette.ramp.length - 1)],
                  ),
                }}
              />
            ))}
          </button>
        ))}
      </div>

      <span className="h-5 w-px shrink-0 bg-white/10" />

      <div className="flex shrink-0 items-center gap-0.5">
        <RoundButton
          onClick={props.onCapture}
          disabled={props.capturing}
          title="Save a still (P)"
        >
          <CameraIcon />
        </RoundButton>
        <RoundButton onClick={props.onSwitchLayout} title="Sidebar menu (M)">
          <SidebarIcon />
        </RoundButton>
        {props.fullscreen.supported && (
          <RoundButton
            onClick={props.fullscreen.toggle}
            title={props.fullscreen.isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          >
            {props.fullscreen.isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </RoundButton>
        )}
        <RoundButton onClick={props.onClose} title="Hide menu (H)">
          <CloseIcon />
        </RoundButton>
      </div>
    </div>
  )
}

function RoundButton({
  onClick,
  title,
  disabled = false,
  children,
}: {
  onClick: () => void
  title: string
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white/90 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}
