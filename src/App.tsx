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
import { CORNER_CLASS, resolveParams, useSettings } from './store/settings'
import { DebugScope } from './ui/debugOverlay'
import { SpectrumMonitor } from './ui/spectrumMonitor'
import { ControlPanel } from './ui/ControlPanel'
import { CompactBar } from './ui/CompactBar'
import { NowPlaying } from './ui/NowPlaying'
import { Footer } from './ui/Footer'
import { GearIcon } from './ui/icons'
import { useFullscreen } from './ui/useFullscreen'
import { useIdle } from './ui/useIdle'
import { useWakeLock } from './ui/useWakeLock'
import {
  SETTLE_FRAMES,
  SETTLE_MAX_MS,
  captureFilename,
  clampCaptureScale,
  downloadBlob,
} from './render/capture'
import type { CaptureRequest } from './render/capture'
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
  const spectrumRef = useRef<SpectrumMonitor | null>(null)
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null)
  const spectrumVisibleRef = useRef(false)
  const captureRef = useRef<CaptureRequest | null>(null)
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
  const nowPlayingCorner = useSettings((s) => s.nowPlayingCorner)
  const nowPlayingSize = useSettings((s) => s.nowPlayingSize)
  const showSpectrum = useSettings((s) => s.showSpectrum)
  const spectrumCorner = useSettings((s) => s.spectrumCorner)
  const spectrumSize = useSettings((s) => s.spectrumSize)
  const autoHide = useSettings((s) => s.autoHide)
  const wakeLockEnabled = useSettings((s) => s.wakeLock)

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
  const toggleNowPlaying = useSettings((s) => s.toggleNowPlaying)
  const setNowPlayingCorner = useSettings((s) => s.setNowPlayingCorner)
  const setNowPlayingSize = useSettings((s) => s.setNowPlayingSize)
  const setShowSpectrum = useSettings((s) => s.setShowSpectrum)
  const toggleSpectrum = useSettings((s) => s.toggleSpectrum)
  const setSpectrumCorner = useSettings((s) => s.setSpectrumCorner)
  const setSpectrumSize = useSettings((s) => s.setSpectrumSize)
  const setAutoHide = useSettings((s) => s.setAutoHide)
  const setWakeLock = useSettings((s) => s.setWakeLock)

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
  const [pointerOverChrome, setPointerOverChrome] = useState(false)
  const [capturing, setCapturing] = useState(false)

  // Chrome hides after 3s idle; hovering it counts as activity so a panel does
  // not vanish out from under the pointer while its value is being read.
  const idle = useIdle(3000, autoHide, pointerOverChrome || capturing)
  const wakeLock = useWakeLock(wakeLockEnabled)
  const chromeHidden = idle

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

      // Still export. Handled here rather than in a callback because feedback
      // modes need real frames at the target size to rebuild their buffers —
      // see render/capture.ts.
      const capture = captureRef.current
      if (capture) {
        if (!capture.started) {
          capture.started = true
          const scale = clampCaptureScale(
            capture.scale,
            stage.width,
            stage.height,
            stage.maxTextureSize,
          )
          capture.scale = scale
          if (scale > 1) {
            stage.setSize(
              window.innerWidth,
              window.innerHeight,
              (window.devicePixelRatio || 1) * scale,
              true,
            )
            modeRef.current?.resize(stage.width, stage.height, stage.dpr)
            // Start the clock after the resize, not at the click: allocating
            // the larger buffers is itself slow and should not eat the settle.
            capture.deadline = now + SETTLE_MAX_MS
          } else {
            // 1x needs no settling: the buffer already holds the live frame.
            capture.remaining = 0
          }
        } else if (capture.remaining > 0 && now < capture.deadline) {
          capture.remaining--
        } else {
          captureRef.current = null
          canvas.toBlob((blob) => capture.resolve(blob), 'image/png')
          if (capture.scale > 1) {
            stage.setSize(
              window.innerWidth,
              window.innerHeight,
              window.devicePixelRatio || 1,
            )
            modeRef.current?.resize(stage.width, stage.height, stage.dpr)
          }
        }
      }
      if (debugVisibleRef.current) {
        scopeRef.current?.draw(signal, bus.audioDebug, bus.sourceLabel, stage.sampleLuminance())
      }
      if (spectrumVisibleRef.current) {
        spectrumRef.current?.draw(signal, bus.sourceLabel)
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
    spectrumVisibleRef.current = showSpectrum
    if (showSpectrum && spectrumCanvasRef.current && !spectrumRef.current) {
      spectrumRef.current = new SpectrumMonitor(spectrumCanvasRef.current)
    }
  }, [showSpectrum])

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

  // --- still export --------------------------------------------------------
  // Declared before the keyboard effect that depends on it: the dependency
  // array is evaluated during render, so a later `const` would be in its TDZ.
  const captureStill = useCallback(async (scale: number) => {
    if (captureRef.current) return
    setCapturing(true)
    try {
      const blob = await new Promise<Blob | null>((resolve) => {
        captureRef.current = {
          scale,
          remaining: scale > 1 ? SETTLE_FRAMES : 0,
          started: false,
          // Replaced with a real deadline once the resize has happened.
          deadline: Number.POSITIVE_INFINITY,
          resolve,
        }
      })
      if (blob) {
        downloadBlob(blob, captureFilename(useSettings.getState().modeId, scale))
      }
    } finally {
      setCapturing(false)
    }
  }, [])

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
        case 'n':
          toggleNowPlaying()
          break
        case 'a':
          toggleSpectrum()
          break
        case 'p':
          // 1x only from the keyboard: it is instant and exact, where a
          // high-resolution export takes seconds and belongs behind a button
          // that can show it is working.
          void captureStill(1)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    toggleDebug,
    togglePanel,
    toggleMenuLayout,
    toggleNowPlaying,
    toggleSpectrum,
    captureStill,
    fullscreen,
  ])

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
      {!panelVisible && !chromeHidden && (
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

      <div
        className={`pointer-events-none absolute inset-0 flex flex-col p-4 transition-opacity duration-500 ${
          chromeHidden ? 'opacity-0' : 'opacity-100'
        }`}
        onPointerEnter={() => setPointerOverChrome(true)}
        onPointerLeave={() => setPointerOverChrome(false)}
        // Fully non-interactive once faded out, or invisible buttons still
        // swallow clicks meant for nothing at all.
        style={{ visibility: chromeHidden ? 'hidden' : 'visible' }}
      >
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
              showNowPlaying={showNowPlaying}
              onShowNowPlaying={setShowNowPlaying}
              nowPlayingCorner={nowPlayingCorner}
              onNowPlayingCorner={setNowPlayingCorner}
              nowPlayingSize={nowPlayingSize}
              onNowPlayingSize={setNowPlayingSize}
              showSpectrum={showSpectrum}
              onShowSpectrum={setShowSpectrum}
              spectrumCorner={spectrumCorner}
              onSpectrumCorner={setSpectrumCorner}
              spectrumSize={spectrumSize}
              onSpectrumSize={setSpectrumSize}
              autoHide={autoHide}
              onAutoHide={setAutoHide}
              wakeLock={wakeLockEnabled}
              onWakeLock={setWakeLock}
              wakeLockActive={wakeLock.active}
              wakeLockSupported={wakeLock.supported}
              capturing={capturing}
              onCapture={(scale) => void captureStill(scale)}
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
              capturing={capturing}
              onCapture={() => void captureStill(1)}
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

      {/* Corner-docked overlays. Positioned absolutely rather than inside the
          layout column so the user can put them in any corner, including the
          one the sidebar is in — that is their call, not the layout's. */}
      {showNowPlaying && spotifyStatus.track && (
        <div className={`absolute ${CORNER_CLASS[nowPlayingCorner]}`}>
          <NowPlaying
            track={spotifyStatus.track}
            progress={progress}
            size={nowPlayingSize}
          />
        </div>
      )}

      <canvas
        ref={spectrumCanvasRef}
        className={`absolute ${CORNER_CLASS[spectrumCorner]} rounded-xl border border-white/10 bg-black/60 backdrop-blur-md ${
          showSpectrum ? 'block' : 'hidden'
        }`}
        style={{ width: `${17 * spectrumSize}rem`, height: `${7 * spectrumSize}rem` }}
      />

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
