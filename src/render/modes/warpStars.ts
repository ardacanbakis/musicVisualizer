/**
 * Warp — flying through a starfield, with the throttle on the music.
 *
 * Stars are not objects here. Each pixel walks a ray outward from the vanishing
 * point and samples a hashed 3D lattice; a cell containing a star contributes a
 * point of light, and the lattice scrolls towards the viewer. That means an
 * unlimited number of stars at a fixed cost, with no per-star bookkeeping, no
 * respawn logic, and no particle buffer.
 *
 * The two things that make it read as motion rather than as static noise:
 *
 * - **Streaks, not dots.** Each star is smeared along the direction it is
 *   travelling, by an amount proportional to speed. This is the entire warp
 *   effect; without it, increasing speed just makes the dots flicker faster.
 * - **Perspective brightness.** A star brightens as it approaches and blows
 *   past the camera. Constant brightness reads as a flat scrolling texture.
 *
 * Ambient-first: the default speed is a slow cruise that looks right with no
 * audio at all. Level drives the throttle and onsets punch it briefly.
 */
import * as THREE from 'three'
import { BAND_COUNT } from '../../signal/types'
import type { Signal } from '../../signal/types'
import { COLOR_HELPERS, FULLSCREEN_VERTEX, HASH_HELPERS } from '../glsl'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

const FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}
  ${HASH_HELPERS}

  uniform sampler2D uBands;
  uniform sampler2D uPalette;
  uniform vec3  uBackground;
  uniform float uDistance;   // accumulated travel, drives the lattice scroll
  uniform float uAspect;
  uniform float uLayers;
  uniform float uDensity;
  uniform float uStreak;
  uniform float uSpeed;
  uniform float uLevel;
  uniform float uGlow;
  uniform float uRoll;
  uniform float uDrift;      // sideways lean of the vanishing point

  varying vec2 vUv;

  vec3 rampAt(float t) {
    return ambSrgbToLinear(texture2D(uPalette, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb);
  }

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);

    // Roll the whole field slowly. A fixed orientation makes a long session
    // feel like a screensaver stuck on one frame of motion.
    float c = cos(uRoll), s = sin(uRoll);
    p = mat2(c, -s, s, c) * p;

    // Vanishing point leans as the drift changes, so the flight path curves.
    p -= vec2(uDrift * 0.12, uDrift * 0.05);

    float radius = length(p);
    vec2 direction = radius > 1e-5 ? p / radius : vec2(0.0, 1.0);

    vec3 color = uBackground;

    // Each layer is a depth slice of the lattice. More layers means more stars
    // at more distances, which is what gives the field volume.
    for (int layer = 0; layer < 6; layer++) {
      if (float(layer) >= uLayers) break;
      float depth = float(layer);

      // Slice-local travel, offset per layer so the layers never pop together.
      float travel = fract(uDistance * (0.6 + depth * 0.22) + depth * 0.37);
      // Perspective: a star's apparent radius grows as it approaches.
      float scale = mix(4.5, 0.35, travel);

      vec2 cellSpace = p * scale * uDensity + vec2(depth * 31.7, depth * 17.3);
      vec2 cell = floor(cellSpace);
      vec2 local = fract(cellSpace) - 0.5;

      vec2 h = hash22(cell + depth * 5.0);
      // Sparse, or the sky is a wall of light rather than stars.
      if (h.x < 0.90) continue;

      vec2 jitter = (vec2(h.y, fract(h.x * 53.7)) - 0.5) * 0.7;
      vec2 offset = local - jitter;

      // Smear along the direction of travel. Distance from the star measured
      // with the along-track axis compressed = a streak pointing outward.
      float along = dot(offset, direction);
      float across = length(offset - direction * along);
      float streakLength = uStreak * uSpeed * (0.4 + travel * 1.6);
      float d = length(vec2(along / max(streakLength, 0.06), across / 0.05));

      // Brightness rises as the star approaches and fades right at the edge
      // of the slice so it does not vanish mid-frame.
      float approach = smoothstep(0.0, 0.25, travel) * smoothstep(1.0, 0.75, travel);
      float brightness = approach * (0.35 + fract(h.y * 91.7) * 0.65);

      float star = exp(-d * d * 3.0) * brightness;

      // Colour by depth: near stars warm, far stars cold. Cheap depth cue and
      // it uses the palette rather than inventing colours.
      color += rampAt(0.35 + travel * 0.6) * star * (0.8 + uLevel * 0.8);
    }

    // Central glow at the vanishing point, so the eye has somewhere to rest.
    color += rampAt(0.55) * exp(-radius * 7.0) * uGlow * 0.18 * (0.4 + uLevel * 0.8);

    gl_FragColor = vec4(color, 1.0);
  }
`

export const warpStarsParams = {
  speed: {
    type: 'float',
    label: 'Cruise speed',
    default: 0.35,
    min: 0.02,
    max: 2,
    step: 0.01,
  },
  throttle: {
    type: 'float',
    label: 'Music throttle',
    hint: 'How much loudness adds to the speed.',
    default: 1,
    min: 0,
    max: 4,
    step: 0.01,
  },
  layers: {
    type: 'int',
    label: 'Depth layers',
    default: 4,
    min: 1,
    max: 6,
    step: 1,
  },
  density: {
    type: 'float',
    label: 'Star density',
    default: 5,
    min: 1,
    max: 16,
    step: 0.25,
  },
  streak: {
    type: 'float',
    label: 'Streak',
    hint: 'How far each star smears. This is the warp.',
    default: 0.45,
    min: 0.02,
    max: 2,
    step: 0.01,
  },
  roll: {
    type: 'float',
    label: 'Roll',
    default: 0.4,
    min: -3,
    max: 3,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Core glow',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
} satisfies ParamSchema

class WarpStarsMode implements VisualMode {
  readonly id = 'warp-stars'
  readonly name = 'Warp'
  readonly description =
    'Flying through a starfield. Loudness is the throttle; onsets punch it and the stars streak.'
  readonly params: ParamSchema = warpStarsParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  /** Accumulated travel. Integrated so speed changes never make stars jump. */
  private distance = 0
  private roll = 0
  private drift = 0
  private boost = 0

  init(ctx: RenderContext): void {
    this.ctx = ctx
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBands: { value: this.bands.texture },
        uPalette: { value: this.palette.texture },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uDistance: { value: 0 },
        uAspect: { value: 1 },
        uLayers: { value: 4 },
        uDensity: { value: 5 },
        uStreak: { value: 0.45 },
        uSpeed: { value: 0.35 },
        uLevel: { value: 0 },
        uGlow: { value: 1 },
        uRoll: { value: 0 },
        uDrift: { value: 0 },
      },
    })
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const material = this.material
    if (!ctx || !material) return

    this.bands.update(signal.bands)
    this.palette.update(signal.palette)

    const calm = ctx.reducedMotion

    // Onsets add a brief burst of speed that decays, rather than a step change.
    // A step makes the whole field jump; a decaying boost reads as acceleration.
    this.boost = Math.max(this.boost * Math.exp(-signal.dt / 0.45), signal.onset * 0.8)

    const cruise = params.speed as number
    const speed =
      (cruise +
        signal.level * (params.throttle as number) * 0.4 +
        this.boost * (params.throttle as number) * 0.3) *
      (calm ? 0.35 : 1)

    // Integrated, so changing the speed slider never teleports the field.
    this.distance += signal.dt * speed
    this.roll += signal.dt * (params.roll as number) * 0.05 * (calm ? 0.3 : 1)
    // Drift wanders on its own slow clock, uncoupled from the music, so the
    // flight path never feels mechanical.
    this.drift = Math.sin(signal.t * 0.037) + Math.sin(signal.t * 0.0163 + 1.3) * 0.5

    const u = material.uniforms
    u.uDistance.value = this.distance
    u.uAspect.value = ctx.width / Math.max(1, ctx.height)
    u.uLayers.value = Math.max(1, Math.round(params.layers as number))
    u.uDensity.value = params.density as number
    u.uStreak.value = params.streak as number
    u.uSpeed.value = Math.max(0.05, speed)
    u.uLevel.value = signal.level
    u.uGlow.value = params.glow as number
    u.uRoll.value = this.roll
    u.uDrift.value = this.drift

    const background = signal.palette.background
    ;(u.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )

    ctx.blit(material, null)
  }

  resize(): void {
    // Aspect is read from the context every frame.
  }

  dispose(): void {
    this.material?.dispose()
    this.palette.dispose()
    this.bands.dispose()
    this.material = null
    this.ctx = null
  }
}

export function createWarpStarsMode(): VisualMode {
  return new WarpStarsMode()
}
