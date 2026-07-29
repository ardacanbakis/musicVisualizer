/**
 * Live spectrum monitor — what the audio source is actually hearing, right now.
 *
 * Distinct from the debug scope (D), which is a diagnostic wall of internals.
 * This is one readable thing: the incoming spectrum on a labelled frequency
 * axis, meant to be left on screen while you use the app.
 *
 * Details that make it readable rather than just a row of bars:
 *
 * - **The axis is labelled in Hz** at the decade and half-decade marks, placed
 *   through the same log mapping the bands themselves use, so a tick sits
 *   exactly where that frequency's band is.
 * - **Peak-hold caps** fall at a constant rate. Bars alone at 60 fps are a blur;
 *   the caps are what let you see where a transient actually reached.
 * - **It says which source it is showing.** Reading a synthetic-LFO spectrum
 *   and thinking it is your microphone would be a genuinely misleading bug, so
 *   the header names the source.
 *
 * Canvas 2D, drawn from the render loop like the debug scope. React would
 * reconcile 60 times a second for a picture that is entirely a canvas.
 */
import { bandCenterFrequencies, frequencyToAxis } from '../audio/bands'
import { BAND_COUNT } from '../signal/types'
import type { Signal } from '../signal/types'

/** Ticks worth labelling on a 30 Hz - 16 kHz log axis. */
const TICKS: { hz: number; label: string }[] = [
  { hz: 50, label: '50' },
  { hz: 100, label: '100' },
  { hz: 250, label: '250' },
  { hz: 500, label: '500' },
  { hz: 1000, label: '1k' },
  { hz: 2500, label: '2.5k' },
  { hz: 5000, label: '5k' },
  { hz: 10000, label: '10k' },
]

/** Screen heights per second the peak caps fall. */
const PEAK_FALL = 0.55

export class SpectrumMonitor {
  private ctx: CanvasRenderingContext2D | null
  private peaks = new Float32Array(BAND_COUNT)
  private centres = bandCenterFrequencies(BAND_COUNT)

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')
  }

  draw(signal: Signal, sourceLabel: string): void {
    const ctx = this.ctx
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return
    const width = rect.width
    const height = rect.height
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(height * dpr)
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const padLeft = 6
    const padRight = 6
    const headerHeight = 15
    const axisHeight = 12
    const plotTop = headerHeight + 2
    const plotBottom = height - axisHeight
    const plotHeight = Math.max(4, plotBottom - plotTop)
    const plotWidth = width - padLeft - padRight

    // --- header ---
    ctx.font = '9px ui-monospace, monospace'
    ctx.textBaseline = 'top'
    ctx.fillStyle = 'rgba(180,190,210,0.65)'
    ctx.fillText(sourceLabel.toUpperCase(), padLeft, 3)

    const readout =
      (signal.bpm !== null ? `${signal.bpm.toFixed(0)} BPM   ` : '') +
      `${Math.round(signal.level * 100)}%`
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(150,160,180,0.55)'
    ctx.fillText(readout, width - padRight, 3)
    ctx.textAlign = 'left'

    // --- grid ---
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    for (const fraction of [0.25, 0.5, 0.75]) {
      const y = Math.round(plotTop + plotHeight * fraction) + 0.5
      ctx.beginPath()
      ctx.moveTo(padLeft, y)
      ctx.lineTo(width - padRight, y)
      ctx.stroke()
    }

    // --- bars ---
    const bands = signal.bands
    const barSlot = plotWidth / bands.length
    const barWidth = Math.max(1, barSlot - 1)
    const fall = PEAK_FALL * signal.dt

    for (let i = 0; i < bands.length; i++) {
      const value = bands[i]
      // Constant-rate fall, same reasoning as the Winamp analyser: a
      // proportional decay makes caps hang forever on tall bars and vanish
      // instantly on short ones.
      this.peaks[i] = Math.max(value, this.peaks[i] - fall)

      const x = padLeft + i * barSlot
      const barHeight = value * plotHeight

      // Hue runs across the spectrum so the eye can locate a frequency
      // without reading the axis every time.
      const hue = 190 - (i / Math.max(1, bands.length - 1)) * 150
      ctx.fillStyle = `hsla(${hue}, 70%, 58%, 0.85)`
      ctx.fillRect(x, plotBottom - barHeight, barWidth, barHeight)

      const peakY = plotBottom - this.peaks[i] * plotHeight
      ctx.fillStyle = 'rgba(255,255,255,0.5)'
      ctx.fillRect(x, Math.max(plotTop, peakY - 1), barWidth, 1.5)
    }

    // --- frequency axis ---
    ctx.font = '8px ui-monospace, monospace'
    ctx.fillStyle = 'rgba(150,160,180,0.45)'
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    for (const tick of TICKS) {
      const t = frequencyToAxis(tick.hz)
      if (t < 0 || t > 1) continue
      const x = padLeft + t * plotWidth
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, plotBottom)
      ctx.lineTo(Math.round(x) + 0.5, plotBottom + 3)
      ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText(tick.label, x, plotBottom + 4)
    }
    ctx.textAlign = 'left'

    // --- dominant band ---
    // The loudest band's centre frequency, which is the single most useful
    // number here and saves squinting at the axis.
    let loudest = 0
    for (let i = 1; i < bands.length; i++) if (bands[i] > bands[loudest]) loudest = i
    if (bands[loudest] > 0.12) {
      const hz = this.centres[loudest]
      const text = hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`
      ctx.font = '9px ui-monospace, monospace'
      ctx.fillStyle = 'rgba(235,240,250,0.7)'
      ctx.textAlign = 'center'
      const x = padLeft + ((loudest + 0.5) / bands.length) * plotWidth
      ctx.fillText(text, Math.min(width - 24, Math.max(24, x)), plotTop + 1)
      ctx.textAlign = 'left'
    }
  }
}
