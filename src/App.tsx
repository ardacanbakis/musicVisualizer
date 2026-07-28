/**
 * App shell.
 *
 * Owns exactly one render loop. The loop reads from refs rather than from React
 * state on purpose: a 60 Hz render must not depend on React having re-rendered,
 * and every mode swap and param change is pushed into a ref by an effect.
 *
 * Everything visual lives in ui/. Everything audio lives behind the bus. This
 * file is the wiring between them and nothing else.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { SignalBus } from './signal/bus'
import { MicrophoneSource } from './signal/sources/microphone'
import { BUILT_IN_PALETTES, cyclePaletteId, paletteById } from './signal/palettes'
import { Stage } from './render/stage'
import { MODES, createMode, cycleModeId, modeEntry } from './render/registry'
import type { VisualMode } from './render/types'
import { resolveParams, useSettings } from './store/settings'
import { DebugScope } from './ui/debugOverlay'
import { ControlPanel } from './ui/ControlPanel'
import { CompactBar } from './ui/CompactBar'
import { NowPlaying } from './ui/NowPlaying'
import { Footer } from './ui/Footer'
import { GearIcon } from './ui/icons'
import { useFullscreen } from './ui/useFullscreen'
import { SpotifyPanel } from './ui/SpotifyPanel'
import { SpotifyClient } from './spotify/client'
import type { SpotifyStatus } from './spotify/client'
import { beginLogin, clearToken, completeLoginFromRedirect, loadToken } from './spotify/auth'

type MicState = 'off' | 'requesting' | 'on' | 'denied' | 'unsupported'

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const debugCanvasRef = useRef<HTMLCanvasElement>(null)

  const busRef = useRef<SignalBus | null>(null)
  const stageRef = useRef<Stage | null>(null)
  const modeRef = useRef<VisualMode | null>(null)
  const scopeRef = useRef<DebugScope | null>(null)
  const spotifyRef = useRef<SpotifyClient | null>(null)
  const paramsRef = useRef(resolveParams(useSettings.getState().modeId, {}))
  const debugVisibleRef = useRef(false)

  const modeId = useSettings((s) => s.modeId)
  const paletteId = useSettings((s) => s.paletteId)
  const savedParams = useSettings((s) => s.params)
  const debugVisible = useSettings((s) => s.debugVisible)
  const panelVisible = useSettings((s) => s.panelVisible)
  const dock = useSettings((s) => s.dock)
  const rotateModes = useSettings((s) => s.rotateModes)
  const rotatePalettes = useSettings((s) => s.rotatePalettes)
  const rotateSeconds = useSettings((s) => s.rotateSeconds)
  const spotifyClientId = useSettings((s) => s.spotifyClientId)
  const menuLayout = useSettings((s) => s.menuLayout)
  const showNowPlaying = useSettings((s) => s.showNowPlaying)

  const setMode = useSettings((s) => s.setMode)
  const setPalette = useSettings((s) => s.setPalette)
  const setParam = useSettings((s) => s.setParam)
  const resetParams = useSettings((s) => s.resetParams)
  const toggleDebug = useSettings((s) => s.toggleDebug)
  const togglePanel = useSettings((s) => s.togglePanel)
  const toggleDock = useSettings((s) => s.toggleDock)
  const setRotateModes = useSettings((s) => s.setRotateModes)
  const setRotatePalettes = useSettings((s) => s.setRotatePalettes)
  const setRotateSeconds = useSettings((s) => s.setRotateSeconds)
  const setSpotifyClientId = useSettings((s) => s.setSpotifyClientId)
  const toggleMenuLayout = useSettings((s) => s.toggleMenuLayout)
  const setShowNowPlaying = useSettings((s) => s.setShowNowPlaying)

  const fullscreen = useFullscreen()
  const entry = modeEntry(modeId)
  const params = resolveParams(modeId, savedParams)

  const [micState, setMicState] = useState<MicState>('off')
  const [sourceLabel, setSourceLabel] = useState('Synthetic')
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyStatus>({
    state: 'disconnected',
    track: null,
    message: null,
    palette: null,
    paletteDetail: null,
  })
  const [progress, setProgress] = useState<number | null>(null)

  // --- one-time setup: stage, bus, render loop -----------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const stage = new Stage(canvas)
    const bus = new SignalBus()
    stageRef.current = stage
    busRef.current = bus

    bus.setPalette(paletteById(useSettings.getState().paletteId), true)

    // Honour the OS setting, and keep honouring it if the user changes it
    // mid-session rather than only reading it once at startup.
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const applyMotion = () => {
      stage.reducedMotion = motionQuery.matches
    }
    applyMotion()
    motionQuery.addEventListener('change', applyMotion)

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
      // Everything the mode drew went into the scene buffer. This is what
      // actually reaches the canvas, with the luminance clamp applied.
      stage.present(signal.dt)
      if (debugVisibleRef.current) {
        scopeRef.current?.draw(signal, bus.audioDebug, bus.sourceLabel, stage.sampleLuminance())
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
      motionQuery.removeEventListener('change', applyMotion)
      document.removeEventListener('visibilitychange', onVisibility)
      modeRef.current?.dispose()
      modeRef.current = null
      spotifyRef.current?.dispose()
      spotifyRef.current = null
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
    // The incoming mode's luminance has nothing to do with the outgoing one's,
    // so carrying the clamp state across would dim the first second of every
    // switch for no reason. Auto-rotate calls fadeIn() just before changing the
    // mode and that must win, so this only primes when no fade is pending.
    if (!stage.isFading) stage.resetLimiter()
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

  // --- auto-rotate ---------------------------------------------------------
  useEffect(() => {
    if (!rotateModes && !rotatePalettes) return

    const timer = window.setInterval(() => {
      const state = useSettings.getState()

      if (state.rotatePalettes) {
        const options = BUILT_IN_PALETTES.filter((p) => p.id !== state.paletteId)
        if (options.length > 0) {
          // The bus already crossfades palettes over ~2s, so this needs no
          // transition handling of its own.
          state.setPalette(options[Math.floor(Math.random() * options.length)].id)
        }
      }

      if (state.rotateModes) {
        const options = MODES.filter((m) => m.id !== state.modeId)
        if (options.length > 0) {
          // Fade the incoming mode up from black. Not a true crossfade — that
          // needs both modes live at once — but far better than a hard cut,
          // and it costs nothing because the luminance limiter already ramps
          // brightness at a bounded rate.
          stageRef.current?.fadeIn()
          state.setMode(options[Math.floor(Math.random() * options.length)].id)
        }
      }
    }, Math.max(15, rotateSeconds) * 1000)

    return () => window.clearInterval(timer)
  }, [rotateModes, rotatePalettes, rotateSeconds])

  useEffect(() => {
    debugVisibleRef.current = debugVisible
    if (debugVisible && debugCanvasRef.current && !scopeRef.current) {
      scopeRef.current = new DebugScope(debugCanvasRef.current)
    }
  }, [debugVisible])

  useEffect(() => {
    if (!spotifyStatus.track) {
      setProgress(null)
      return
    }
    const timer = window.setInterval(() => {
      setProgress(busRef.current?.currentPlayhead ?? null)
    }, 200)
    return () => window.clearInterval(timer)
  }, [spotifyStatus.track])

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Don't steal keys from a focused control — the param sliders respond to
      // arrow keys and a text field wants every letter.
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const state = useSettings.getState()
      const backwards = event.shiftKey ? -1 : 1

      // Digits jump straight to a mode, so a specific one is one keystroke
      // away rather than several presses of S.
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1
        if (index < MODES.length) {
          stageRef.current?.fadeIn()
          state.setMode(MODES[index].id)
        }
        return
      }

      switch (event.key.toLowerCase()) {
        case 'c':
          state.setPalette(cyclePaletteId(state.paletteId, backwards))
          break
        case 's':
          stageRef.current?.fadeIn()
          state.setMode(cycleModeId(state.modeId, backwards))
          break
        case 'd':
          toggleDebug()
          break
        case 'f':
          fullscreen.toggle()
          break
        case 'h':
          togglePanel()
          break
        case 'm':
          toggleMenuLayout()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleDebug, togglePanel, toggleMenuLayout, fullscreen])

  // --- microphone ----------------------------------------------------------
  const enableMic = useCallback(async () => {
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
  }, [])

  const disableMic = useCallback(() => {
    busRef.current?.setAudioSource(null)
    setMicState('off')
    setSourceLabel('Synthetic')
  }, [])

  // --- spotify -------------------------------------------------------------
  const startSpotify = useCallback(
    (clientId: string) => {
      const bus = busRef.current
      const token = loadToken()
      if (!bus || !token || !clientId) return
      spotifyRef.current?.dispose()
      const client = new SpotifyClient(clientId, bus, setSpotifyStatus)
      spotifyRef.current = client
      client.start(token)
    },
    [],
  )

  // Handle the redirect back from Spotify, then resume an existing session.
  useEffect(() => {
    const clientId = useSettings.getState().spotifyClientId
    if (!clientId) return
    let cancelled = false
    void (async () => {
      const fromRedirect = await completeLoginFromRedirect(clientId)
      if (cancelled) return
      if (fromRedirect || loadToken()) startSpotify(clientId)
    })()
    return () => {
      cancelled = true
    }
  }, [startSpotify])

  const connectSpotify = useCallback(() => {
    if (!spotifyClientId) return
    setSpotifyStatus({
      state: 'connecting',
      track: null,
      message: null,
      palette: null,
      paletteDetail: null,
    })
    void beginLogin(spotifyClientId)
  }, [spotifyClientId])

  const disconnectSpotify = useCallback(() => {
    spotifyRef.current?.dispose()
    spotifyRef.current = null
    clearToken()
    busRef.current?.setTrack(null)
    busRef.current?.setPlayhead(null)
    // Back to whichever built-in palette was selected before Spotify took over.
    busRef.current?.setPalette(paletteById(useSettings.getState().paletteId))
    setSpotifyStatus({
      state: 'disconnected',
      track: null,
      message: null,
      palette: null,
      paletteDetail: null,
    })
  }, [])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* Menu hidden: one small button, positioned on its own rather than as
          a stretched child of the layout column. */}
      {!panelVisible && (
        <button
          onClick={togglePanel}
          title="Show menu (H)"
          aria-label="Show menu"
          className={`absolute top-4 ${
            dock === 'right' ? 'right-4' : 'left-4'
          } rounded-lg border border-white/10 bg-black/40 p-2 text-white/25 backdrop-blur transition hover:bg-black/70 hover:text-white/80`}
        >
          <GearIcon />
        </button>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col p-4">
        {/* min-h-0 is what lets this row shrink so the footer keeps its space;
            without it the panel claims the full column and clips the footer. */}
        <div
          className={`flex min-h-0 flex-1 ${
            dock === 'right' ? 'justify-end' : 'justify-start'
          }`}
        >
          {panelVisible && menuLayout === 'sidebar' ? (
            <ControlPanel
              dock={dock}
              onToggleDock={toggleDock}
              onSwitchLayout={toggleMenuLayout}
              onClose={togglePanel}
              fullscreen={fullscreen}
              micState={micState}
              sourceLabel={sourceLabel}
              onEnableMic={() => void enableMic()}
              onDisableMic={disableMic}
              modeId={modeId}
              onSelectMode={setMode}
              paletteId={paletteId}
              onSelectPalette={setPalette}
              schema={entry.params}
              params={params}
              onParamChange={(key, value) => setParam(modeId, key, value)}
              onParamReset={() => resetParams(modeId)}
              rotateModes={rotateModes}
              rotatePalettes={rotatePalettes}
              rotateSeconds={rotateSeconds}
              onRotateModes={setRotateModes}
              onRotatePalettes={setRotatePalettes}
              onRotateSeconds={setRotateSeconds}
              spotify={
                <SpotifyPanel
                  clientId={spotifyClientId}
                  onClientId={setSpotifyClientId}
                  status={spotifyStatus}
                  onConnect={connectSpotify}
                  onDisconnect={disconnectSpotify}
                  showNowPlaying={showNowPlaying}
                  onShowNowPlaying={setShowNowPlaying}
                />
              }
            />
          ) : null}
        </div>

        {/* Now Playing sits opposite the sidebar so the two never collide. */}
        {showNowPlaying && spotifyStatus.track && (
          <div
            className={`flex shrink-0 pb-3 ${
              dock === 'right' ? 'justify-start' : 'justify-end'
            }`}
          >
            <NowPlaying
              track={spotifyStatus.track}
              progress={progress}
              side={dock === 'right' ? 'left' : 'right'}
            />
          </div>
        )}

        {panelVisible && menuLayout === 'compact' && (
          <div className="flex shrink-0 justify-center pb-2">
            <CompactBar
              micState={micState}
              modeId={modeId}
              onSelectMode={setMode}
              paletteId={paletteId}
              onSelectPalette={setPalette}
              onSwitchLayout={toggleMenuLayout}
              onClose={togglePanel}
              fullscreen={fullscreen}
            />
          </div>
        )}

        {/* Tracks the menu rather than fullscreen: hiding the menu is the
            request for a bare screen, and fullscreen with the menu open is
            still a view someone is looking at. */}
        {panelVisible && (
          <div className="flex shrink-0 justify-center pt-1">
            <Footer />
          </div>
        )}
      </div>

      <canvas
        ref={debugCanvasRef}
        className={`absolute ${
          dock === 'right' ? 'left-4' : 'right-4'
        } top-4 h-[360px] w-[420px] rounded-lg border border-white/10 ${
          debugVisible ? 'block' : 'hidden'
        }`}
      />
    </div>
  )
}
