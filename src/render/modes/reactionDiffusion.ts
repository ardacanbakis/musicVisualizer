/**
 * Gray-Scott reaction-diffusion.
 *
 * Two chemicals, A and B. A is fed in at rate `feed`, B is removed at rate
 * `kill`, and the reaction A + 2B -> 3B converts one into the other. Both
 * diffuse, at different rates. That is the entire model, and the family of
 * patterns it produces — spots, stripes, mitosis, coral, solitons — is
 * decided almost entirely by where (feed, kill) sits in a very small region of
 * parameter space.
 *
 * Three things this implementation cares about that a naive one does not:
 *
 * 1. **It runs at a fraction of canvas resolution.** The pattern's feature
 *    size is set by the diffusion rates in *texels*, so at 4K the structures
 *    would be pinpricks and it would cost 8x more to compute them. Rendering
 *    the simulation small and upsampling with a linear filter is both faster
 *    and better looking.
 *
 * 2. **Multiple iterations per frame.** One step per frame at dt=1 evolves far
 *    too slowly to watch; the pattern would take minutes to develop. Several
 *    steps per frame is standard for Gray-Scott.
 *
 * 3. **(feed, kill) is clamped to the interesting region.** Most of the plane
 *    is a fixed point — the whole field decays to uniform A and stops, and the
 *    screen goes blank and never recovers. `mood.energy` drifts the parameters
 *    *within* the region that stays alive, so an eight-hour run keeps evolving
 *    instead of dying at 40 minutes.
 */
import * as THREE from 'three'
import type { Signal } from '../../signal/types'
import { COLOR_HELPERS, FULLSCREEN_VERTEX, HASH_HELPERS } from '../glsl'
import { PaletteTexture } from '../paletteTexture'
import type {
  ParamSchema,
  ParamValues,
  PingPong,
  RenderContext,
  VisualMode,
} from '../types'

/** Simulation runs at canvas size divided by this. */
const RESOLUTION_DIVISOR = 2
/** The simulation is square; a non-square grid makes the pattern anisotropic. */
const MAX_SIM_SIZE = 1024

const SEED_FRAGMENT = /* glsl */ `
  precision highp float;
  ${HASH_HELPERS}
  uniform float uSeed;
  varying vec2 vUv;
  void main() {
    // Start saturated in A with scattered patches of B. A uniform field is a
    // fixed point of the system and would never do anything at all — the
    // pattern only exists because of the perturbation.
    vec2 cell = floor(vUv * 18.0);
    float blob = hash22(cell + uSeed).x;
    float b = blob > 0.86 ? 1.0 : 0.0;
    // Soften the patch edges so the first few seconds aren't visibly blocky.
    b *= smoothstep(0.0, 0.35, 1.0 - length(fract(vUv * 18.0) - 0.5) * 2.0);
    gl_FragColor = vec4(1.0, b, 0.0, 1.0);
  }
`

const STEP_FRAGMENT = /* glsl */ `
  precision highp float;

  ${HASH_HELPERS}

  uniform sampler2D uState;
  uniform vec2 uTexel;
  uniform float uFeed;
  uniform float uKill;
  uniform float uDiffuseA;
  uniform float uDiffuseB;
  uniform float uTimestep;
  uniform float uOnset;
  uniform float uSeedTime;

  varying vec2 vUv;

  void main() {
    // Nine-point Laplacian. The five-point version is cheaper but its error is
    // anisotropic: patterns visibly align to the texture axes and you get
    // square-ish blobs instead of round ones.
    vec2 s = uTexel;
    vec2 sum =
      texture2D(uState, vUv + vec2(-s.x, -s.y)).xy * 0.05 +
      texture2D(uState, vUv + vec2( 0.0, -s.y)).xy * 0.20 +
      texture2D(uState, vUv + vec2( s.x, -s.y)).xy * 0.05 +
      texture2D(uState, vUv + vec2(-s.x,  0.0)).xy * 0.20 +
      texture2D(uState, vUv + vec2( s.x,  0.0)).xy * 0.20 +
      texture2D(uState, vUv + vec2(-s.x,  s.y)).xy * 0.05 +
      texture2D(uState, vUv + vec2( 0.0,  s.y)).xy * 0.20 +
      texture2D(uState, vUv + vec2( s.x,  s.y)).xy * 0.05;

    vec2 state = texture2D(uState, vUv).xy;
    vec2 laplacian = sum - state;

    float a = state.x;
    float b = state.y;
    float reaction = a * b * b;

    float da = uDiffuseA * laplacian.x - reaction + uFeed * (1.0 - a);
    float db = uDiffuseB * laplacian.y + reaction - (uKill + uFeed) * b;

    vec2 next = state + vec2(da, db) * uTimestep;

    // Onsets drop fresh B into a few scattered cells, which seeds new growth
    // fronts. Without this the pattern eventually settles and stops changing.
    if (uOnset > 0.01) {
      vec2 cell = floor(vUv * 26.0);
      float pick = hash22(cell + floor(uSeedTime)).y;
      if (pick > 1.0 - uOnset * 0.05) next.y = min(1.0, next.y + 0.55);
    }

    gl_FragColor = vec4(clamp(next, 0.0, 1.0), 0.0, 1.0);
  }
`

const RENDER_FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}

  uniform sampler2D uState;
  uniform sampler2D uPalette;
  uniform vec2 uTexel;
  uniform vec3 uBackground;
  uniform float uSharpness;
  uniform float uRelief;

  varying vec2 vUv;

  void main() {
    vec2 state = texture2D(uState, vUv).xy;
    float b = state.y;

    // Map concentration through the palette. The useful range of B is roughly
    // 0..0.4, so stretch it or the whole picture sits in the darkest stop.
    float t = clamp(b * 2.2, 0.0, 1.0);
    t = pow(t, uSharpness);

    vec3 ink = ambSrgbToLinear(texture2D(uPalette, vec2(t, 0.5)).rgb);

    // Shade by the concentration gradient. This is what makes a flat chemical
    // field read as a surface with structure rather than a stain — it is the
    // single highest-value line in this shader.
    float bx = texture2D(uState, vUv + vec2(uTexel.x, 0.0)).y
             - texture2D(uState, vUv - vec2(uTexel.x, 0.0)).y;
    float by = texture2D(uState, vUv + vec2(0.0, uTexel.y)).y
             - texture2D(uState, vUv - vec2(0.0, uTexel.y)).y;
    // Light from the upper left, the convention that reads as "lit" rather
    // than "inverted" to most eyes.
    float shade = 1.0 + uRelief * (bx * 6.0 + by * 6.0);

    vec3 color = mix(uBackground, ink * max(shade, 0.0), smoothstep(0.02, 0.12, b));
    gl_FragColor = vec4(color, 1.0);
  }
`

export const reactionDiffusionParams = {
  pattern: {
    type: 'enum',
    label: 'Pattern',
    hint: 'Where in Gray-Scott parameter space to sit. Each is a different regime.',
    default: 'coral',
    options: [
      { value: 'coral', label: 'Coral' },
      { value: 'mitosis', label: 'Mitosis' },
      { value: 'solitons', label: 'Solitons' },
      { value: 'maze', label: 'Maze' },
      { value: 'flicker', label: 'Waves' },
    ],
  },
  speed: {
    type: 'float',
    label: 'Simulation speed',
    hint: 'Iterations per frame. Higher evolves faster and costs more.',
    default: 8,
    min: 1,
    max: 24,
    step: 1,
  },
  drift: {
    type: 'float',
    label: 'Energy drift',
    hint: 'How far mood.energy moves the feed/kill rates.',
    default: 1,
    min: 0,
    max: 2,
    step: 0.01,
  },
  sharpness: {
    type: 'float',
    label: 'Colour sharpness',
    default: 1.05,
    min: 0.2,
    max: 3,
    step: 0.01,
  },
  relief: {
    type: 'float',
    label: 'Relief',
    hint: 'Gradient shading. Makes the field read as a surface.',
    default: 0.6,
    min: 0,
    max: 2,
    step: 0.01,
  },
  onsetSeed: {
    type: 'float',
    label: 'Onset seeding',
    hint: 'How much new growth an onset injects.',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.01,
  },
} satisfies ParamSchema

/**
 * Base (feed, kill) per regime, and the direction energy pushes them.
 *
 * These are not arbitrary: outside a narrow band the system has a single
 * stable fixed point and the pattern dies. The drift vectors were chosen to
 * stay inside the live region across the full 0..1 energy range.
 */
const REGIMES: Record<string, { feed: number; kill: number; dFeed: number; dKill: number }> = {
  coral: { feed: 0.0545, kill: 0.062, dFeed: 0.004, dKill: 0.001 },
  mitosis: { feed: 0.0367, kill: 0.0649, dFeed: 0.003, dKill: 0.0008 },
  solitons: { feed: 0.03, kill: 0.062, dFeed: 0.004, dKill: 0.0012 },
  maze: { feed: 0.029, kill: 0.057, dFeed: 0.003, dKill: 0.001 },
  flicker: { feed: 0.014, kill: 0.045, dFeed: 0.004, dKill: 0.002 },
}

class ReactionDiffusionMode implements VisualMode {
  readonly id = 'reaction-diffusion'
  readonly name = 'Reaction Diffusion'
  readonly description =
    'Gray-Scott chemistry on a feedback buffer. Feed and kill rates drift with the mood, so the pattern keeps evolving.'
  readonly params: ParamSchema = reactionDiffusionParams

  private ctx: RenderContext | null = null
  private state: PingPong | null = null
  private simSize = 0

  private seedMaterial: THREE.ShaderMaterial | null = null
  private stepMaterial: THREE.ShaderMaterial | null = null
  private renderMaterial: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()

  private seeded = false
  private lastPattern = ''

  init(ctx: RenderContext): void {
    this.ctx = ctx

    this.seedMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: SEED_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: { uSeed: { value: 0 } },
    })

    this.stepMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: STEP_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uState: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uFeed: { value: 0.0545 },
        uKill: { value: 0.062 },
        // Classic Gray-Scott ratio: B must diffuse slower than A or no
        // structure forms at all, it just blurs to uniform.
        uDiffuseA: { value: 1.0 },
        uDiffuseB: { value: 0.5 },
        uTimestep: { value: 1.0 },
        uOnset: { value: 0 },
        uSeedTime: { value: 0 },
      },
    })

    this.renderMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: RENDER_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uState: { value: null },
        uPalette: { value: this.palette.texture },
        uTexel: { value: new THREE.Vector2() },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uSharpness: { value: 0.75 },
        uRelief: { value: 0.6 },
      },
    })

    this.allocate()
  }

  private allocate(): void {
    const ctx = this.ctx
    if (!ctx) return
    const size = Math.min(
      MAX_SIM_SIZE,
      Math.max(
        128,
        Math.floor(Math.max(ctx.width, ctx.height) / RESOLUTION_DIVISOR),
      ),
    )
    if (size === this.simSize && this.state) return
    this.simSize = size

    this.state?.dispose()
    this.state = ctx.createPingPong({
      width: size,
      height: size,
      // Float, not half float: concentrations differ by ~1e-4 between
      // neighbours and half float quantises those away, which freezes the
      // pattern into visible stair-steps.
      type: THREE.FloatType,
      filter: THREE.LinearFilter,
    })
    this.seeded = false

    const texel = new THREE.Vector2(1 / size, 1 / size)
    ;(this.stepMaterial!.uniforms.uTexel.value as THREE.Vector2).copy(texel)
    ;(this.renderMaterial!.uniforms.uTexel.value as THREE.Vector2).copy(texel)
  }

  private seed(): void {
    const ctx = this.ctx
    const state = this.state
    const seedMaterial = this.seedMaterial
    if (!ctx || !state || !seedMaterial) return
    seedMaterial.uniforms.uSeed.value = Math.random() * 1000
    // Both halves, so the first step reads a seeded buffer whichever way the
    // ping-pong happens to be facing.
    ctx.blit(seedMaterial, state.write)
    state.swap()
    ctx.blit(seedMaterial, state.write)
    state.swap()
    this.seeded = true
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const state = this.state
    const step = this.stepMaterial
    const render = this.renderMaterial
    if (!ctx || !state || !step || !render) return

    const pattern = params.pattern as string
    if (pattern !== this.lastPattern) {
      this.lastPattern = pattern
      // A regime change from a pattern grown under different rates produces
      // mush. Reseeding gives the new regime a clean start.
      if (this.seeded) this.seeded = false
    }
    if (!this.seeded) this.seed()

    this.palette.update(signal.palette)

    const regime = REGIMES[pattern] ?? REGIMES.coral
    const drift = (params.drift as number) * (signal.mood.energy - 0.5) * 2
    step.uniforms.uFeed.value = regime.feed + regime.dFeed * drift
    step.uniforms.uKill.value = regime.kill + regime.dKill * drift
    step.uniforms.uOnset.value = signal.onset * (params.onsetSeed as number)
    step.uniforms.uSeedTime.value = signal.t * 60

    // Reduced motion: fewer iterations, so the pattern creeps instead of
    // boiling. Genuinely calmer, not just dimmer.
    const iterations = Math.max(
      1,
      Math.round((params.speed as number) * (ctx.reducedMotion ? 0.35 : 1)),
    )
    for (let i = 0; i < iterations; i++) {
      step.uniforms.uState.value = state.read.texture
      // Onset seeding only on the first iteration; applying it every
      // iteration would dump 8x the intended amount of B in one frame.
      if (i === 1) step.uniforms.uOnset.value = 0
      ctx.blit(step, state.write)
      state.swap()
    }

    const background = signal.palette.background
    render.uniforms.uState.value = state.read.texture
    ;(render.uniforms.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )
    render.uniforms.uSharpness.value = params.sharpness as number
    render.uniforms.uRelief.value = params.relief as number
    ctx.blit(render, null)
  }

  resize(): void {
    this.allocate()
  }

  dispose(): void {
    this.state?.dispose()
    this.seedMaterial?.dispose()
    this.stepMaterial?.dispose()
    this.renderMaterial?.dispose()
    this.palette.dispose()
    this.state = null
    this.seedMaterial = null
    this.stepMaterial = null
    this.renderMaterial = null
    this.ctx = null
    this.simSize = 0
  }
}

export function createReactionDiffusionMode(): VisualMode {
  return new ReactionDiffusionMode()
}
