/**
 * App shell.
 *
 * Owns exactly one render loop. The loop reads from refs rather than from React
 * state on purpose: a 60 Hz render must not depend on React having re-rendered,
 * and every mode swap and param change is pushed into a ref by an effect.
 *
 * The ambient shell proper — fullscreen, auto-hide, wake lock, auto-rotate — is
 * phase 6. What is here is the minimum needed to drive and inspect the signal.
 */
import { useEffect, useRef, useState } from 'react'
import { SignalBus } from './signal/bus'
import { MicrophoneSource } from './signal/sources/microphone'
import { BUILT_IN_PALETTES, paletteById } from './signal/palettes'
import { Stage } from './render/stage'
import { MODES, createMode } from './render/registry'
import type { VisualMode } from './render/types'
import { resolveParams, useSettings } from './store/settings'
import { DebugScope } from './ui/debugOverlay'

type MicState = 'off' | 'requesting' | 'on' | 'denied' | 'unsupported'

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const debugCanvasRef = useRef<HTMLCanvasElement>(null)

  const busRef = useRef<SignalBus | null>(null)
  const stageRef = useRef<Stage | null>(null)
  const modeRef = useRef<VisualMode | null>(null)
  const scopeRef = useRef<DebugScope | null>(null)
  const paramsRef = useRef(resolveParams(useSettings.getState().modeId, {}))
  const debugVisibleRef = useRef(false)

  const modeId = useSettings((s) => s.modeId)
  const paletteId = useSettings((s) => s.paletteId)
  const savedParams = useSettings((s) => s.params)
  const debugVisible = useSettings((s) => s.debugVisible)
  const toggleDebug = useSettings((s) => s.toggleDebug)
  const setMode = useSettings((s) => s.setMode)
  const setPalette = useSettings((s) => s.setPalette)

  const [micState, setMicState] = useState<MicState>('off')
  const [sourceLabel, setSourceLabel] = useState('Synthetic')

  // --- one-time setup: stage, bus, render loop -----------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const stage = new Stage(canvas)
    const bus = new SignalBus()
    stageRef.current = stage
    busRef.current = bus

    bus.setPalette(paletteById(useSettings.getState().paletteId), true)

    const applySize = () => {
      stage.setSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1)
      modeRef.current?.resize(stage.width, stage.height, stage.dpr)
    }
    applySize()
    window.addEventListener('resize', applySize)

    let raf = 0
    let running = true

    const loop = (now: number) => {
      if (!running) return
      raf = requestAnimationFrame(loop)
      const signal = bus.update(now)
      modeRef.current?.frame(signal, paramsRef.current)
      if (debugVisibleRef.current) {
        scopeRef.current?.draw(signal, bus.audioDebug, bus.sourceLabel)
      }
    }
    raf = requestAnimationFrame(loop)

    // Stop burning GPU on a hidden tab. Also avoids the multi-second dt that a
    // backgrounded tab hands you on return (the bus clamps it, but there is no
    // reason to render frames nobody can see).
    const onVisibility = () => {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running) {
        running = true
        raf = requestAnimationFrame(loop)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', applySize)
      document.removeEventListener('visibilitychange', onVisibility)
      modeRef.current?.dispose()
      modeRef.current = null
      bus.dispose()
      stage.dispose()
      busRef.current = null
      stageRef.current = null
    }
  }, [])

  // --- mode lifecycle ------------------------------------------------------
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    modeRef.current?.dispose()
    const mode = createMode(modeId)
    mode.init(stage)
    mode.resize(stage.width, stage.height, stage.dpr)
    modeRef.current = mode
    return () => {
      // Disposing here as well as above is intentional: a mode swap must free
      // its GPU resources at the moment of the swap, not whenever the next one
      // happens to mount.
      if (modeRef.current === mode) {
        mode.dispose()
        modeRef.current = null
      }
    }
  }, [modeId])

  useEffect(() => {
    paramsRef.current = resolveParams(modeId, savedParams)
  }, [modeId, savedParams])

  useEffect(() => {
    busRef.current?.setPalette(paletteById(paletteId))
  }, [paletteId])

  useEffect(() => {
    debugVisibleRef.current = debugVisible
    if (debugVisible && debugCanvasRef.current && !scopeRef.current) {
      scopeRef.current = new DebugScope(debugCanvasRef.current)
    }
  }, [debugVisible])

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.key === 'd' || event.key === 'D') toggleDebug()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDebug])

  // --- microphone ----------------------------------------------------------
  const enableMic = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState('unsupported')
      return
    }
    setMicState('requesting')
    try {
      const source = await MicrophoneSource.open()
      busRef.current?.setAudioSource(source)
      setMicState('on')
      setSourceLabel('Microphone')
    } catch {
      // Denied, no device, or an insecure origin. Either way the synthetic
      // source is already running and the visuals never stopped.
      setMicState('denied')
      setSourceLabel('Synthetic')
    }
  }

  const disableMic = () => {
    busRef.current?.setAudioSource(null)
    setMicState('off')
    setSourceLabel('Synthetic')
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />

      <div className="pointer-events-none absolute inset-0 p-4">
        <div className="pointer-events-auto inline-flex flex-col gap-3 rounded-lg border border-white/10 bg-black/55 p-4 text-sm text-white/85 backdrop-blur">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                micState === 'on' ? 'bg-emerald-400' : 'bg-white/35'
              }`}
            />
            <span className="font-mono text-xs uppercase tracking-wide text-white/60">
              {sourceLabel}
            </span>
          </div>

          {micState === 'on' ? (
            <button
              onClick={disableMic}
              className="rounded border border-white/15 px-3 py-1.5 text-left hover:bg-white/10"
            >
              Disconnect microphone
            </button>
          ) : (
            <button
              onClick={enableMic}
              disabled={micState === 'requesting'}
              className="rounded border border-white/15 px-3 py-1.5 text-left hover:bg-white/10 disabled:opacity-50"
            >
              {micState === 'requesting' ? 'Requesting…' : 'Enable microphone'}
            </button>
          )}

          {micState === 'denied' && (
            <p className="max-w-[15rem] text-xs text-white/45">
              No microphone access. Running on synthetic audio.
            </p>
          )}
          {micState === 'unsupported' && (
            <p className="max-w-[15rem] text-xs text-white/45">
              This browser has no microphone API here. Needs https or localhost.
            </p>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-white/45">Mode</span>
            <select
              value={modeId}
              onChange={(e) => setMode(e.target.value)}
              className="rounded border border-white/15 bg-black/60 px-2 py-1"
            >
              {MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-white/45">Palette</span>
            <select
              value={paletteId}
              onChange={(e) => setPalette(e.target.value)}
              className="rounded border border-white/15 bg-black/60 px-2 py-1"
            >
              {BUILT_IN_PALETTES.map((palette) => (
                <option key={palette.id} value={palette.id}>
                  {palette.name}
                </option>
              ))}
            </select>
          </label>

          <p className="text-xs text-white/35">Press D for the debug scope.</p>
        </div>
      </div>

      <canvas
        ref={debugCanvasRef}
        className={`absolute right-4 top-4 h-[340px] w-[420px] rounded-lg border border-white/10 ${
          debugVisible ? 'block' : 'hidden'
        }`}
      />
    </div>
  )
}
