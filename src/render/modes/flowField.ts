/**
 * Flow field — GPGPU particles advected through a divergence-free noise field,
 * accumulated into a feedback buffer for trails.
 *
 * Structure, because the data flow is the hard part to read back later:
 *
 *   positions (ping-pong, RGBA float)   xy = position, z = life, w = seed
 *        |  simulate: advect by flowVelocity(), age, respawn
 *        v
 *   points (THREE.Points, one vertex per texel, vertex shader fetches position)
 *        |  additive into...
 *        v
 *   trails (ping-pong)                  r = colour coordinate * weight, g = weight
 *        |  faded each frame, then composited through the palette
 *        v
 *   scene buffer -> luminance limiter -> canvas
 *
 * The trail buffer stores a *weighted* colour coordinate rather than a colour,
 * so overlapping particles average their palette position instead of summing
 * into white. Dividing r by g at composite time recovers the mean.
 *
 * Ambient-first: with no audio the field still circulates from its own slow
 * time evolution, particles still age and respawn, and trails still breathe.
 * Audio warps a picture that is already alive rather than being the only thing
 * that makes it move — a mode that is a black screen in a quiet room is a
 * failed mode.
 */
import * as THREE from 'three'
import { BAND_COUNT } from '../../signal/types'
import type { Signal } from '../../signal/types'
import {
  COLOR_HELPERS,
  FLOW_HELPERS,
  FULLSCREEN_VERTEX,
  HASH_HELPERS,
  SIMPLEX_NOISE,
} from '../glsl'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import type {
  ParamSchema,
  ParamValues,
  PingPong,
  RenderContext,
  VisualMode,
} from '../types'

/** Particle count is this squared. */
const TEXTURE_SIZES: Record<string, number> = {
  small: 128, // 16k
  medium: 256, // 65k
  large: 512, // 262k
}

const SIMULATE_FRAGMENT = /* glsl */ `
  precision highp float;

  ${SIMPLEX_NOISE}
  ${FLOW_HELPERS}
  ${HASH_HELPERS}

  uniform sampler2D uPositions;
  uniform float uDt;
  uniform float uTime;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uWarp;
  uniform float uOnset;
  uniform float uBurst;
  uniform float uAspect;
  uniform float uLifetime;

  varying vec2 vUv;

  vec4 spawn(vec2 uv, float salt) {
    vec2 p = hash22(uv * 137.0 + salt);
    return vec4(p, 1.0, hash11(uv.x * 71.0 + uv.y * 197.0 + salt));
  }

  void main() {
    vec4 particle = texture2D(uPositions, vUv);
    vec2 position = particle.xy;
    float life = particle.z;
    float seed = particle.w;

    // Aspect-correct the sampling position so the flow structure stays
    // circular on a 21:9 display instead of being stretched into ovals.
    vec2 flowPos = vec2(position.x * uAspect, position.y);
    vec2 velocity = flowVelocity(flowPos, uTime, uScale, uWarp);

    position += velocity * uSpeed * uDt * 0.06;

    // Per-particle lifetime spread. Without it every particle respawns at once
    // and the screen pulses on a fixed period.
    life -= uDt / (uLifetime * (0.5 + seed));

    bool escaped = position.x < -0.05 || position.x > 1.05 ||
                   position.y < -0.05 || position.y > 1.05;

    // Onsets inject particles: a random slice of the pool is recycled, which
    // reads as a burst of new material without disturbing the rest. Respawning
    // everything would flush the whole picture on every kick drum.
    float roll = hash11(seed * 811.0 + floor(uTime * 60.0));
    bool injected = roll < uOnset * uBurst;

    if (life <= 0.0 || escaped || injected) {
      gl_FragColor = spawn(vUv, floor(uTime * 60.0) + seed);
      return;
    }

    gl_FragColor = vec4(position, life, seed);
  }
`

const POINTS_VERTEX = /* glsl */ `
  precision highp float;

  uniform sampler2D uPositions;
  uniform sampler2D uBands;
  uniform float uPointSize;
  uniform float uLevel;
  uniform float uDpr;

  varying float vWeight;
  varying float vCoord;

  void main() {
    // position.xy is this particle's texel in the position texture, not a
    // location — the actual location is fetched here.
    vec4 particle = texture2D(uPositions, position.xy);
    vec2 pos = particle.xy;
    float life = particle.z;
    float seed = particle.w;

    gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);

    // Fade in and out over the particle's life so nothing pops into or out of
    // existence — with trails on, a pop leaves a visible hard end.
    float fade = smoothstep(0.0, 0.15, life) * smoothstep(1.0, 0.75, life);
    vWeight = fade * (0.35 + uLevel * 0.65);

    // Palette coordinate: mostly the particle's own seed so the field shows
    // the whole ramp at once, nudged by the band this particle listens to so
    // the spectrum is legible in the colour distribution.
    float band = texture2D(uBands, vec2(seed, 0.5)).r;
    vCoord = clamp(seed * 0.75 + band * 0.35, 0.0, 1.0);

    gl_PointSize = uPointSize * uDpr * (0.7 + band * 0.9);
  }
`

const POINTS_FRAGMENT = /* glsl */ `
  precision highp float;

  varying float vWeight;
  varying float vCoord;

  void main() {
    // Round, soft-edged point. gl_PointCoord is 0..1 across the sprite.
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    float alpha = exp(-r * 3.0) * vWeight;
    // Premultiplied: r carries coordinate*weight, g carries weight.
    gl_FragColor = vec4(vCoord * alpha, alpha, 0.0, 1.0);
  }
`

const FADE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uTrails;
  uniform float uFade;
  varying vec2 vUv;
  void main() {
    vec4 previous = texture2D(uTrails, vUv);
    // Subtract a floor as well as scaling, so trails actually reach zero.
    // Pure multiplicative decay asymptotes and leaves a permanent haze that
    // slowly fills the screen over an eight-hour run.
    vec4 faded = previous * uFade - 0.0004;
    gl_FragColor = max(faded, vec4(0.0));
  }
`

const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}

  uniform sampler2D uTrails;
  uniform sampler2D uPalette;
  uniform vec3 uBackground;
  uniform float uGlow;

  varying vec2 vUv;

  void main() {
    vec2 trail = texture2D(uTrails, vUv).rg;
    float weight = trail.g;
    // Recover the mean palette coordinate from the weighted sum.
    float coord = weight > 1e-4 ? trail.r / weight : 0.0;

    vec3 ink = ambSrgbToLinear(texture2D(uPalette, vec2(clamp(coord, 0.0, 1.0), 0.5)).rgb);

    // Density curve: soft roll-off so dense regions bloom rather than clip to
    // a flat plateau, which is what makes the accumulation read as light.
    float density = 1.0 - exp(-weight * 1.6);

    vec3 color = uBackground + ink * density * (1.0 + uGlow * density);
    gl_FragColor = vec4(color, 1.0);
  }
`

export const flowFieldParams = {
  particles: {
    type: 'enum',
    label: 'Particles',
    hint: 'Higher counts cost GPU. 65k suits most displays.',
    default: 'medium',
    options: [
      { value: 'small', label: '16k' },
      { value: 'medium', label: '65k' },
      { value: 'large', label: '262k' },
    ],
  },
  scale: {
    type: 'float',
    label: 'Field scale',
    hint: 'Small values give a few large vortices; large values give fine turbulence.',
    default: 2.2,
    min: 0.5,
    max: 8,
    step: 0.1,
  },
  speed: {
    type: 'float',
    label: 'Flow speed',
    default: 1,
    min: 0.05,
    max: 3,
    step: 0.01,
  },
  trail: {
    type: 'float',
    label: 'Trail length',
    default: 0.94,
    min: 0.5,
    max: 0.995,
    step: 0.001,
  },
  pointSize: {
    type: 'float',
    label: 'Particle size',
    default: 1.6,
    min: 0.5,
    max: 6,
    step: 0.1,
  },
  bandWarp: {
    type: 'float',
    label: 'Bass warp',
    hint: 'How much the low bands add turbulence to the field.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  burst: {
    type: 'float',
    label: 'Onset burst',
    hint: 'Fraction of particles recycled on an onset.',
    default: 0.12,
    min: 0,
    max: 0.6,
    step: 0.005,
  },
  glow: {
    type: 'float',
    label: 'Glow',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.01,
  },
  lifetime: {
    type: 'float',
    label: 'Particle life',
    hint: 'Seconds before a particle recycles.',
    default: 6,
    min: 1,
    max: 20,
    step: 0.5,
  },
} satisfies ParamSchema

class FlowFieldMode implements VisualMode {
  readonly id = 'flow-field'
  readonly name = 'Flow Field'
  readonly description =
    'Particles carried through a slowly evolving divergence-free noise field, drawn as long trails.'
  readonly params: ParamSchema = flowFieldParams

  private ctx: RenderContext | null = null

  private positions: PingPong | null = null
  private trails: PingPong | null = null
  private textureSize = 0

  private simulate: THREE.ShaderMaterial | null = null
  private fade: THREE.ShaderMaterial | null = null
  private composite: THREE.ShaderMaterial | null = null
  private pointsMaterial: THREE.ShaderMaterial | null = null
  private pointsGeometry: THREE.BufferGeometry | null = null
  private points: THREE.Points | null = null
  private pointsScene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private seeded = false

  init(ctx: RenderContext): void {
    this.ctx = ctx

    this.simulate = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: SIMULATE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPositions: { value: null },
        uDt: { value: 1 / 60 },
        uTime: { value: 0 },
        uScale: { value: 2.2 },
        uSpeed: { value: 1 },
        uWarp: { value: 0 },
        uOnset: { value: 0 },
        uBurst: { value: 0.12 },
        uAspect: { value: 1 },
        uLifetime: { value: 6 },
      },
    })

    this.fade = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FADE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: { uTrails: { value: null }, uFade: { value: 0.94 } },
    })

    this.composite = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTrails: { value: null },
        uPalette: { value: this.palette.texture },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uGlow: { value: 0.5 },
      },
    })

    this.pointsMaterial = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERTEX,
      fragmentShader: POINTS_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPositions: { value: null },
        uBands: { value: this.bands.texture },
        uPointSize: { value: 1.6 },
        uLevel: { value: 0 },
        uDpr: { value: ctx.dpr },
      },
    })

    this.allocateTrails()
    this.allocateParticles(TEXTURE_SIZES.medium)
  }

  private allocateTrails(): void {
    const ctx = this.ctx
    if (!ctx) return
    this.trails?.dispose()
    this.trails = ctx.createPingPong({ type: THREE.HalfFloatType })
    this.trails.clear(0, 0, 0, 1)
  }

  /** (Re)build the particle pool. Called on init and whenever the count changes. */
  private allocateParticles(size: number): void {
    const ctx = this.ctx
    if (!ctx || size === this.textureSize) return
    this.textureSize = size

    this.positions?.dispose()
    this.positions = ctx.createPingPong({
      width: size,
      height: size,
      type: THREE.FloatType,
      // Nearest: each texel is one particle's state, and interpolating
      // between two unrelated particles is meaningless.
      filter: THREE.NearestFilter,
    })
    this.seeded = false

    this.pointsGeometry?.dispose()
    const geometry = new THREE.BufferGeometry()
    const refs = new Float32Array(size * size * 3)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3
        refs[i] = (x + 0.5) / size
        refs[i + 1] = (y + 0.5) / size
        refs[i + 2] = 0
      }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(refs, 3))
    // The vertex shader ignores the bounding volume entirely.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.pointsGeometry = geometry

    if (this.points) this.pointsScene.remove(this.points)
    this.points = new THREE.Points(geometry, this.pointsMaterial!)
    this.points.frustumCulled = false
    this.pointsScene.add(this.points)
  }

  /**
   * Seed the pool by running the simulation shader with a lifetime of zero,
   * which sends every particle down the respawn branch. Cheaper than uploading
   * a CPU-generated texture and it reuses the hash the shader already has.
   */
  private seed(): void {
    const simulate = this.simulate
    const positions = this.positions
    if (!simulate || !positions || !this.ctx) return
    simulate.uniforms.uPositions.value = positions.read.texture
    simulate.uniforms.uLifetime.value = 1e-6
    simulate.uniforms.uDt.value = 1
    this.ctx.blit(simulate, positions.write)
    positions.swap()
    this.seeded = true
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const simulate = this.simulate
    const fade = this.fade
    const composite = this.composite
    const points = this.pointsMaterial
    if (!ctx || !simulate || !fade || !composite || !points) return

    const requested = TEXTURE_SIZES[params.particles as string] ?? TEXTURE_SIZES.medium
    this.allocateParticles(requested)
    const positions = this.positions
    const trails = this.trails
    if (!positions || !trails) return

    if (!this.seeded) this.seed()

    this.bands.update(signal.bands)
    this.palette.update(signal.palette)

    // Low bands drive turbulence. Averaging the bottom quarter rather than
    // taking one band keeps it from twitching on a single frequency.
    let bass = 0
    const bassBands = Math.max(1, Math.floor(signal.bands.length * 0.25))
    for (let i = 0; i < bassBands; i++) bass += signal.bands[i]
    bass /= bassBands

    // Reduced motion: slower drift, fewer recycles, longer trails. A genuinely
    // calmer variant, not the same animation at 90%.
    const calm = ctx.reducedMotion
    const speedScale = calm ? 0.35 : 1
    const burstScale = calm ? 0.25 : 1

    // --- simulate ---
    simulate.uniforms.uPositions.value = positions.read.texture
    simulate.uniforms.uDt.value = signal.dt
    simulate.uniforms.uTime.value = signal.t * 0.05
    simulate.uniforms.uScale.value = params.scale as number
    simulate.uniforms.uSpeed.value = (params.speed as number) * speedScale
    simulate.uniforms.uWarp.value = bass * (params.bandWarp as number)
    simulate.uniforms.uOnset.value = signal.onset
    simulate.uniforms.uBurst.value = (params.burst as number) * burstScale
    simulate.uniforms.uAspect.value = ctx.width / Math.max(1, ctx.height)
    simulate.uniforms.uLifetime.value = (params.lifetime as number) * (calm ? 1.8 : 1)
    ctx.blit(simulate, positions.write)
    positions.swap()

    // --- fade the trail buffer, then draw particles on top ---
    const trailParam = params.trail as number
    fade.uniforms.uTrails.value = trails.read.texture
    // Trail length is authored per-frame but must be frame-rate independent,
    // or a 144 Hz display gets visibly shorter trails than a 60 Hz one.
    fade.uniforms.uFade.value = Math.pow(
      calm ? Math.min(0.99, trailParam + 0.03) : trailParam,
      signal.dt * 60,
    )
    ctx.blit(fade, trails.write)

    points.uniforms.uPositions.value = positions.read.texture
    points.uniforms.uPointSize.value = params.pointSize as number
    points.uniforms.uLevel.value = signal.level
    points.uniforms.uDpr.value = ctx.dpr

    ctx.renderer.setRenderTarget(trails.write)
    ctx.renderer.render(this.pointsScene, this.camera)
    ctx.renderer.setRenderTarget(null)
    trails.swap()

    // --- composite through the palette ---
    const background = signal.palette.background
    composite.uniforms.uTrails.value = trails.read.texture
    ;(composite.uniforms.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )
    composite.uniforms.uGlow.value = params.glow as number
    ctx.blit(composite, null)
  }

  resize(): void {
    // Trails are canvas-sized, so they must be rebuilt. Their contents are
    // lost, which is correct — a stretched trail buffer looks worse than a
    // couple of seconds of re-accumulation.
    this.allocateTrails()
  }

  dispose(): void {
    this.positions?.dispose()
    this.trails?.dispose()
    this.simulate?.dispose()
    this.fade?.dispose()
    this.composite?.dispose()
    this.pointsMaterial?.dispose()
    this.pointsGeometry?.dispose()
    if (this.points) this.pointsScene.remove(this.points)
    this.pointsScene.clear()
    this.palette.dispose()
    this.bands.dispose()
    this.positions = null
    this.trails = null
    this.simulate = null
    this.fade = null
    this.composite = null
    this.pointsMaterial = null
    this.pointsGeometry = null
    this.points = null
    this.ctx = null
    this.textureSize = 0
  }
}

export function createFlowFieldMode(): VisualMode {
  return new FlowFieldMode()
}
