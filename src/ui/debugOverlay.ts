/**
 * The debug scope.
 *
 * This is not throwaway phase-2 scaffolding — it stays in the shipped app
 * behind a keyboard shortcut, because when a mode misbehaves the first question
 * is always "is the signal wrong or is the shader wrong?" and this answers it
 * in about two seconds.
 *
 * Plain canvas 2D on its own element. Deliberately not React: it updates every
 * frame and reconciling that would cost more than the whole visualiser.
 */
import type { Signal } from '../signal/types'
import type { AudioDebug } from '../signal/sources/types'

const HISTORY = 300

export class DebugScope {
  private ctx: CanvasRenderingContext2D | null
  private flux = new Float32Array(HISTORY)
  private threshold = new Float32Array(HISTORY)
  private onsets = new Float32Array(HISTORY)
  private level = new Float32Array(HISTORY)
  private cursor = 0

  private frameTimes: number[] = []
  private fps = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')
  }

  private syncSize(): { width: number; height: number } {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = this.canvas.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width * dpr))
    const height = Math.max(1, Math.round(rect.height * dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    return { width: rect.width, height: rect.height }
  }

  draw(
    signal: Signal,
    debug: AudioDebug | null,
    sourceLabel: string,
    luminance?: { measured: number; allowed: number; gain: number } | null,
  ): void {
    const ctx = this.ctx
    if (!ctx) return

    // --- fps over a 1 s window ---
    const now = performance.now()
    this.frameTimes.push(now)
    while (this.frameTimes.length > 0 && now - this.frameTimes[0] > 1000) {
      this.frameTimes.shift()
    }
    this.fps = this.frameTimes.length

    // --- history ---
    const i = this.cursor
    this.flux[i] = debug?.flux ?? 0
    this.threshold[i] = debug?.threshold ?? 0
    this.onsets[i] = signal.onset
    this.level[i] = signal.level
    this.cursor = (this.cursor + 1) % HISTORY

    const { width, height } = this.syncSize()
    const dpr = this.canvas.width / Math.max(1, width)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = 'rgba(6, 8, 12, 0.88)'
    ctx.fillRect(0, 0, width, height)

    const pad = 10
    const innerWidth = width - pad * 2
    let y = pad

    // --- readouts ---
    ctx.font = '11px ui-monospace, monospace'
    ctx.textBaseline = 'top'

    const bpmText = signal.bpm === null ? '--' : signal.bpm.toFixed(1)
    const confidence = debug ? (debug.tempoConfidence * 100).toFixed(0) : '0'
    const lines: [string, string][] = [
      ['source', sourceLabel],
      ['fps', `${this.fps}  dt ${(signal.dt * 1000).toFixed(1)}ms`],
      ['level', signal.level.toFixed(3)],
      ['bpm', `${bpmText}  conf ${confidence}%`],
      ['gate', debug ? debug.gate.toFixed(2) : 'n/a'],
      ['raw', debug ? debug.rawLevel.toExponential(2) : 'n/a'],
      [
        'mood',
        `e${signal.mood.energy.toFixed(2)} w${signal.mood.warmth.toFixed(2)} ` +
          `c${signal.mood.contrast.toFixed(2)} d${signal.mood.density.toFixed(2)}`,
      ],
      // gain below 1 means the limiter is actively holding a flash back.
      [
        'luma',
        luminance
          ? `${luminance.measured.toFixed(3)} -> ${luminance.allowed.toFixed(3)}  ` +
            `gain ${luminance.gain.toFixed(2)}`
          : 'n/a',
      ],
    ]
    for (const [label, value] of lines) {
      ctx.fillStyle = 'rgba(150,160,180,0.9)'
      ctx.fillText(label, pad, y)
      ctx.fillStyle = 'rgba(235,240,250,0.95)'
      ctx.fillText(value, pad + 52, y)
      y += 14
    }

    y += 6

    // --- bands ---
    const bandHeight = 54
    this.label(ctx, 'bands', pad, y)
    y += 13
    const bands = signal.bands
    const barWidth = innerWidth / bands.length
    for (let b = 0; b < bands.length; b++) {
      const h = bands[b] * bandHeight
      ctx.fillStyle = 'rgba(90,180,255,0.85)'
      ctx.fillRect(pad + b * barWidth, y + bandHeight - h, Math.max(1, barWidth - 1), h)
    }
    ctx.strokeStyle = 'rgba(120,130,150,0.35)'
    ctx.strokeRect(pad, y, innerWidth, bandHeight)
    y += bandHeight + 10

    // --- flux vs threshold, with onset markers ---
    const scopeHeight = 56
    this.label(ctx, 'flux / threshold / onset', pad, y)
    y += 13

    // Autoscale to the visible window; flux magnitude varies hugely by source.
    let peak = 1e-6
    for (let k = 0; k < HISTORY; k++) {
      if (this.flux[k] > peak) peak = this.flux[k]
      if (this.threshold[k] > peak) peak = this.threshold[k]
    }

    const xAt = (k: number) => pad + (k / (HISTORY - 1)) * innerWidth
    const readAt = (buffer: Float32Array, k: number) =>
      buffer[(this.cursor + k) % HISTORY]

    // onset markers first, so the traces draw over them
    for (let k = 0; k < HISTORY; k++) {
      const value = readAt(this.onsets, k)
      if (value <= 0.001) continue
      ctx.fillStyle = `rgba(255, 210, 70, ${0.15 + value * 0.55})`
      ctx.fillRect(xAt(k), y, Math.max(1, innerWidth / HISTORY), scopeHeight)
    }

    this.trace(ctx, this.flux, y, scopeHeight, peak, 'rgba(120,255,190,0.95)', xAt, readAt)
    this.trace(
      ctx,
      this.threshold,
      y,
      scopeHeight,
      peak,
      'rgba(255,110,110,0.9)',
      xAt,
      readAt,
    )

    ctx.strokeStyle = 'rgba(120,130,150,0.35)'
    ctx.strokeRect(pad, y, innerWidth, scopeHeight)
    y += scopeHeight + 10

    // --- level history + beat phase ---
    const levelHeight = 34
    this.label(ctx, 'level / beat', pad, y)
    y += 13
    this.trace(ctx, this.level, y, levelHeight, 1, 'rgba(200,170,255,0.95)', xAt, readAt)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(pad + signal.beatPhase * innerWidth - 1, y, 2, levelHeight)
    ctx.strokeStyle = 'rgba(120,130,150,0.35)'
    ctx.strokeRect(pad, y, innerWidth, levelHeight)
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    ctx.fillStyle = 'rgba(150,160,180,0.9)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.fillText(text, x, y)
    ctx.font = '11px ui-monospace, monospace'
  }

  private trace(
    ctx: CanvasRenderingContext2D,
    buffer: Float32Array,
    top: number,
    height: number,
    peak: number,
    color: string,
    xAt: (k: number) => number,
    readAt: (buffer: Float32Array, k: number) => number,
  ): void {
    ctx.beginPath()
    for (let k = 0; k < HISTORY; k++) {
      const value = Math.min(1, readAt(buffer, k) / peak)
      const py = top + height - value * height
      if (k === 0) ctx.moveTo(xAt(k), py)
      else ctx.lineTo(xAt(k), py)
    }
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()
  }
}
