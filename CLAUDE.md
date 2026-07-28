# Ambient Audio-Reactive Visualizer

A browser-based generative visualiser that reacts to live audio from the
microphone, with an optional Spotify connection supplying colour and track
identity.

**It is an ambient screen piece.** It runs fullscreen for hours on a second
monitor or a TV, in a quiet room, with other people in it. It is not a VJ tool
and not a music player. Every design decision follows from that sentence — most
importantly, a mode that only looks good during a drop is a failed mode.

---

## The two contracts that must not drift

Everything else in this repo is negotiable. These two are not.

### 1. `Signal` — `src/signal/types.ts`

Sources produce a `Signal`. Renderers consume it. **Neither knows the other
exists.**

```ts
type Signal = {
  t: number              // seconds since app start
  dt: number             // seconds since last frame (clamped, never 0 or huge)
  bands: Float32Array    // BAND_COUNT log-spaced energy bands, each 0..1, smoothed
  waveform: Float32Array // WAVEFORM_SIZE time-domain samples, -1..1, gated
  level: number          // overall normalised loudness, 0..1
  onset: number          // 0..1, spikes to 1 on a detected onset, then decays
  beatPhase: number      // 0..1 sawtooth synced to estimated tempo
  bpm: number | null     // null until the estimator is confident
  palette: Palette       // ALWAYS present, never null
  track: TrackInfo | null
  playhead: number | null  // 0..1 through the current track
  mood: { energy: number; warmth: number; contrast: number; density: number }
}
```

**The rule that makes this work:** a renderer must never branch on whether the
microphone or Spotify is connected. If a source is absent, the bus synthesises a
plausible substitute so the contract is always satisfied.

- **No microphone** — `bands`, `level`, `onset` and `beatPhase` come from layered
  LFOs at a plausible tempo. The visuals keep breathing. This is the default
  state on first load, before any permission prompt.
- **No Spotify** — `palette` comes from a built-in set. `track` and `playhead`
  are null.

If you find yourself writing `if (micConnected)` in a mode, the bus has a bug.
Fix the bus.

`waveform` was added after the original contract, for oscilloscope modes: a
spectrum has discarded the phase, so a scope cannot be built from `bands`. The
extension is additive, existing modes ignore it, and the bus always populates
it (the synthetic source generates a plausible trace) — so both properties that
matter still hold. That is the bar any future addition has to clear.

`bpm` is the one field allowed to be null while audio is playing, and that is
deliberate: a visual pulsing at the wrong tempo looks far worse than one that is
not pulsing at all. The synthetic source reports `bpm: null` even though it knows
its own tempo, because reporting it would let a mode display a BPM for a silent
room.

### 2. `VisualMode` — `src/render/types.ts`

Adding visual mode number twelve must mean **writing one file and adding one
import**. Nothing else.

```ts
interface VisualMode {
  id: string           // stable, persisted to localStorage; never change once shipped
  name: string
  description: string
  params: ParamSchema  // declarative; the settings UI is generated from this
  init(ctx: RenderContext): void
  frame(signal: Signal, params: ParamValues): void
  resize(w: number, h: number, dpr: number): void
  dispose(): void      // MUST free every GPU resource it allocated
  capture?(scale: number): Promise<Blob>
}
```

Rules:

- **No mode may import from another mode.** Shared code goes in `src/render/`
  (e.g. `paletteTexture.ts`) and both import that.
- **`params` is declarative.** The settings panel is generated from the schema.
  Do not hand-write a control panel for a mode.
- **Mode constructors must be side-effect free.** The registry instantiates a
  throwaway probe to read metadata. All GPU work belongs in `init()`.
- **`dispose()` must free everything.** This app runs 8+ hours and rotates
  modes. A leaked framebuffer is a crash by morning.
- **Use the shared ping-pong helper** (`RenderContext.createPingPong`) for
  feedback buffers. Reaction-diffusion and flow-field trails both need them, and
  each mode reimplementing "two targets and a swap" is how this rots.

---

## Layout

```
src/
  signal/           the bus and its contract — the centre of the app
    types.ts        PUBLIC API: Signal, Palette, TrackInfo, Mood
    bus.ts          stitches sources together, makes absence invisible
    color.ts        palette construction; shared by built-ins and (phase 5) k-means
    palettes.ts     the built-in, no-Spotify palettes
    sources/
      types.ts      AudioSource interface
      synthetic.ts  layered-LFO fallback
      microphone.ts the real DSP chain
  audio/            pure DSP, all unit tested without a microphone
    bands.ts        FFT bin -> log-spaced band mapping
    envelope.ts     asymmetric attack/release follower
    normalise.ts    rolling per-band normalisation + noise gate
    onset.ts        spectral flux + adaptive median threshold
    tempo.ts        IOI histogram tempo estimator + beat clock
  render/
    types.ts        PUBLIC API: VisualMode, ParamSchema, RenderContext
    stage.ts        the shared WebGLRenderer, blit, ping-pong
    luminanceLimiter.ts  the anti-strobe clamp; every frame goes through it
    glsl.ts         shared shader snippets + the COLOUR SPACE CONVENTION
    registry.ts     one array; add a mode here
    params.ts       schema defaults merged with saved overrides
    paletteTexture.ts  palette, ramp, band and waveform textures; shared
    modes/          one file per mode
  spotify/          optional; the app is complete without any of it
    auth.ts         OAuth PKCE — no client secret, deployable as a static site
    client.ts       polling, token refresh, pushes palette/track into the bus
    playhead.ts     local interpolation between 4 s polls, pure and tested
    albumPalette.ts album art -> downsample -> worker -> buildPalette
    kmeans.ts       pure, seeded, deterministic; kmeans.worker.ts wraps it
  ui/
    ControlPanel.tsx  the dockable panel; sections, mode list, shortcuts
    SpotifyPanel.tsx  connect/setup; errors appear HERE and nowhere else
    debugOverlay.ts the debug scope (press D)
    ParamPanel.tsx  the generated settings UI; never hand-write a mode's panel
    PalettePicker.tsx  swatch grid; palettes are picked by sight, not by name
    Footer.tsx      social links; hidden in fullscreen and when the panel is
  store/
    settings.ts     zustand + localStorage
```

## Audio pipeline notes

The parts where naive implementations fall apart, and what was done instead:

- `getUserMedia` with `echoCancellation`, `noiseSuppression` and
  `autoGainControl` **all off**. All three are tuned for speech and each one
  destroys music.
- `AnalyserNode` with `fftSize: 2048` and `smoothingTimeConstant: 0`. Its
  built-in smoothing is a symmetric EMA; we do our own asymmetric one.
- **Log-spaced bands, not linear.** Linear wastes almost everything on
  inaudible high frequencies.
- **Asymmetric envelope** (fast attack, slow release) so it feels responsive
  without being jittery.
- **Rolling normalisation** per band with a floor, so a quiet room and a loud
  room look the same and silence is not amplified into noise. Implemented as a
  decaying peak-hold rather than a ring-buffer sliding max — a true sliding max
  drops discontinuously when the old peak leaves the window, which is visible
  on screen as a step change in brightness.
- **Spectral flux is divided by current frame energy.** This makes it a
  proportion ("how much of what I'm hearing is new"), which is volume-invariant
  — otherwise every threshold needs retuning whenever the speakers move.
- **Adaptive median threshold** over ~1 s, with a ~100 ms refractory period.
  Median rather than mean specifically because a big onset drags a mean upward
  and masks the onsets right after it.
- **Hysteresis everywhere a decision is made** — the noise gate and the tempo
  lock both have separate open/close thresholds. A single cutoff makes anything
  hovering near it chatter, and chatter reads as flicker on screen.

Several constants here were set by measurement against a synthetic reference
track, not by eye, and the code says so where that is true. The noise gate
thresholds in particular are an order of magnitude below where intuition puts
them, because the level they compare against is a mean across all bands.

**Do not call `/v1/audio-features` or `/v1/audio-analysis`.** They return 403 for
any app created after November 2024. All rhythmic information comes from the
microphone.

## Spotify notes

Entirely optional — the app is fully usable and attractive without it, and
that is the test any change here has to pass.

- **The client id is a runtime setting**, entered in the panel and kept in
  localStorage. It is not a secret (it is in the authorize URL of every
  Spotify web app) but it is per-deployment, so baking it in would stop
  anyone running their own copy. The redirect URI must be registered in the
  Spotify dashboard exactly as the panel displays it, trailing slash included
  — dev and production are different URIs and both need registering.
- **Every failure degrades silently.** Declined consent, expired refresh
  token, revoked app, offline, a 429, album art the CDN serves without CORS
  headers so the canvas taints and `getImageData` throws — all of it lands in
  the settings panel and never on the canvas. This thing lives on a wall.
- **Palette extraction is deterministic**, seeded from the track id, so a
  track you have heard before comes back the same colour. k-means runs in a
  worker because it lands exactly when a crossfade starts.
- **The playhead is interpolated locally** and only resynced past 250 ms of
  drift. Snapping to every poll re-introduces the jitter interpolation exists
  to remove, since each response is already stale by its network latency.

## Rendering conventions

**Modes work in linear light.** Every mode writes linear values into the scene
buffer; the stage's present pass does the one and only sRGB encode. Blending,
additive accumulation and the luminance limiter are all averaging operations,
and averaging gamma-encoded values gives the wrong answer. Palette texels are
8-bit sRGB tagged `NoColorSpace` — raw `ShaderMaterial`s get no automatic
decode from three, so shaders call `ambSrgbToLinear` explicitly. Shared GLSL
helpers are prefixed `amb` because three injects its own `luminance` and the
names collide. See `src/render/glsl.ts`.

**`ctx.blit(material, null)` does not reach the canvas.** null means the scene
buffer. Only the luminance limiter draws to the glass, so no mode can bypass
the clamp — that is the point of putting it in the stage rather than asking
every mode to behave.

## Ambient behaviour requirements

These are features, not polish:

- ✅ No strobing. `luminanceLimiter.ts` reduces each frame to its mean linear
  luminance on the GPU and caps how fast that may rise (1.2/s normally, 0.45/s
  under reduced motion). Falls freely — the hazard is the flash *to* bright,
  and holding luminance up while a frame darkens would mean amplifying noise.
  No CPU readback in the normal path; the debug scope can ask for one.
- ✅ `prefers-reduced-motion` is on `RenderContext` and watched live. Modes MUST
  give a genuinely calmer variant, not the same animation slightly slower.
- Must survive 8+ hours without leaking. Dispose every geometry, material,
  texture and framebuffer on mode switch. Device pixel ratio is capped at 2.
- Chrome auto-hides after 3 s of mouse idle. Screen Wake Lock so the display
  does not sleep. Render loop pauses entirely when the tab is hidden.
- An expired or revoked Spotify token degrades silently to the no-Spotify state.
  **Never show an error wall** — this thing lives on a wall.

## Commands

```
npm run dev        # vite dev server
npm test           # vitest, the pure DSP
npm run build      # tsc -b && vite build
npm run typecheck
```

Press **D** in the app for the debug scope (bands, flux vs threshold, onsets,
level, beat phase, BPM and confidence). It stays in the shipped app on purpose:
when a mode misbehaves the first question is always "is the signal wrong or is
the shader wrong?", and this answers it in about two seconds.

## Build order

1. ✅ Signal bus, synthetic LFO source, trivial renderer (colour bars)
2. ✅ Microphone pipeline, debug overlay
3. ✅ Mode registry, auto-generated param UI, flow field
   (luminance clamp and reduced-motion pulled forward from 6, so every mode
   from here is built against them rather than retrofitted)
4. ✅ Reaction-diffusion, geometric tiling, 3D terrain, lava lamp, Winamp
   (a fireplace mode was built and then removed at the user's request; it is
   in git history if it is ever wanted back)
5. ✅ Spotify auth, polling, palette extraction, crossfade
6. Ambient shell — auto-hide on idle, wake lock
   (fullscreen, the settings show/hide toggle and auto-rotate landed early;
   auto-rotate fades the incoming mode up from black rather than a true
   two-mode crossfade, which would need both modes live at once)
7. Frame capture and high-resolution still export
