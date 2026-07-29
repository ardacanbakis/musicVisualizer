/**
 * Aurora — curtains of light over a dark horizon.
 *
 * Each curtain is a vertical band of emission whose *horizontal position*
 * wanders with noise and whose brightness falls off with height. That is the
 * whole model, and it is chosen because it matches what an aurora actually is:
 * a sheet seen edge-on, so the eye reads folds in the sheet rather than a
 * texture on a flat plane.
 *
 * The details that matter:
 *
 * - **Vertical falloff is not symmetric.** Real curtains are bright and sharp
 *   at the bottom where the sheet is dense, and diffuse at the top. A symmetric
 *   gradient looks like a stripe.
 * - **Each curtain has its own drift rate**, so they slide past one another.
 *   Shared motion makes the whole sky move as one object, which is the single
 *   most common way a faked aurora gives itself away.
 * - **Colour comes from height, not from the curtain.** In the real thing the
 *   emission colour changes with altitude; here that means sampling the palette
 *   by height, which keeps the sky coherent no matter how many curtains overlap.
 *
 * Ambient-first: curtains drift and fold from their own noise clock with no
 * audio at all. The spectrum leans on which curtains brighten, and onsets send
 * a ripple along them.
 */
import * as THREE from 'three'
import { BAND_COUNT } from '../../signal/types'
import type { Signal } from '../../signal/types'
import { COLOR_HELPERS, FULLSCREEN_VERTEX, HASH_HELPERS, SIMPLEX_NOISE } from '../glsl'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

const FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}
  ${HASH_HELPERS}
  ${SIMPLEX_NOISE}

  uniform sampler2D uBands;
  uniform sampler2D uPalette;
  uniform vec3  uBackground;
  uniform float uTime;
  uniform float uAspect;
  uniform float uCurtains;
  uniform float uHeight;
  uniform float uFold;
  uniform float uWidth;
  uniform float uLevel;
  uniform float uRipple;
  uniform float uGlow;
  uniform float uStars;
  uniform float uHorizon;

  varying vec2 vUv;

  vec3 rampAt(float t) {
    return ambSrgbToLinear(texture2D(uPalette, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb);
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      total += snoise(vec3(p, uTime * 0.03)) * amplitude;
      p *= 2.07;
      amplitude *= 0.5;
    }
    return total;
  }

  void main() {
    vec2 uv = vUv;
    float x = (uv.x - 0.5) * uAspect;

    vec3 color = uBackground;

    // --- stars above the horizon ---
    if (uStars > 0.01) {
      vec2 grid = vec2(x, uv.y) * 34.0;
      vec2 cell = floor(grid);
      vec2 local = fract(grid) - 0.5;
      vec2 h = hash22(cell);
      if (h.x > 0.90) {
        float d = length(local - (vec2(h.y, fract(h.x * 37.1)) - 0.5) * 0.6);
        float twinkle = 0.6 + 0.4 * sin(uTime * (0.7 + h.y * 2.0) + h.x * 30.0);
        // Stars thin out towards the horizon, as haze does to them.
        float altitude = smoothstep(uHorizon, uHorizon + 0.25, uv.y);
        color += rampAt(0.9) * smoothstep(0.09, 0.0, d) * twinkle * altitude * uStars * 0.5;
      }
    }

    // --- curtains ---
    float sky = smoothstep(uHorizon - 0.02, uHorizon + 0.02, uv.y);
    float total = 0.0;
    float weighted = 0.0;

    for (int i = 0; i < 8; i++) {
      if (float(i) >= uCurtains) break;
      float fi = float(i);
      vec2 seed = hash22(vec2(fi * 13.7, 4.1));

      // Each curtain drifts at its own rate. Shared motion is the giveaway
      // that makes a faked aurora look like one object sliding sideways.
      float drift = uTime * (0.012 + seed.x * 0.03) + fi * 2.7;

      // Horizontal position folds with noise: this is the sheet seen edge-on.
      float fold = fbm(vec2(uv.y * uFold + fi * 5.3, drift)) * 0.7;
      float centre = (seed.y - 0.5) * 1.4 + fold;

      // Onsets travel up the curtain as a ripple rather than flashing it.
      float ripple = sin(uv.y * 14.0 - uTime * 2.2 + fi) * uRipple * 0.04;
      centre += ripple;

      float distance = abs(x - centre);
      float width = uWidth * (0.5 + seed.x * 0.9);
      float band = exp(-(distance * distance) / max(width * width, 1e-4));

      // Asymmetric vertical profile: dense and defined low down, diffuse high.
      float low = smoothstep(uHorizon, uHorizon + 0.06, uv.y);
      float high = 1.0 - smoothstep(uHorizon + 0.15, uHorizon + uHeight, uv.y);
      float profile = low * high;

      // Fine vertical striations — the rays within a curtain.
      float rays = 0.62 + 0.38 * snoise(vec3(x * 30.0 + fi * 11.7, uv.y * 3.0 - uTime * 0.25, fi * 2.3));

      // Each curtain listens to its own slice of the spectrum.
      float energy = texture2D(uBands, vec2((fi + 0.5) / max(uCurtains, 1.0), 0.5)).r;

      float strength = band * profile * rays * (0.45 + energy * 0.9);
      total += strength;
      weighted += strength * uv.y;
    }

    if (total > 1e-4) {
      // Colour by height rather than by curtain, so overlapping curtains stay
      // coherent instead of fighting over hue.
      float meanHeight = clamp((weighted / total - uHorizon) / max(uHeight, 0.01), 0.0, 1.0);
      vec3 ink = rampAt(0.25 + meanHeight * 0.7);
      float density = 1.0 - exp(-total * 1.25);
      color += ink * density * sky * (0.7 + uLevel * 0.6) * (1.0 + uGlow * density * 0.6);
    }

    // --- ground ---
    // A faint reflection below the horizon. Cheap, and it stops the bottom of
    // the frame being a dead black bar.
    float ground = 1.0 - sky;
    if (ground > 0.01) {
      float mirrored = uHorizon * 2.0 - uv.y;
      float fade = exp(-(uHorizon - uv.y) * 9.0);
      color += rampAt(0.3) * total * 0.12 * fade * ground * step(0.0, mirrored);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`

export const auroraParams = {
  curtains: {
    type: 'int',
    label: 'Curtains',
    default: 5,
    min: 1,
    max: 8,
    step: 1,
  },
  height: {
    type: 'float',
    label: 'Curtain height',
    default: 0.7,
    min: 0.2,
    max: 1.2,
    step: 0.01,
  },
  width: {
    type: 'float',
    label: 'Curtain width',
    default: 0.075,
    min: 0.03,
    max: 0.6,
    step: 0.005,
  },
  fold: {
    type: 'float',
    label: 'Fold',
    hint: 'How much the sheet waves as it rises.',
    default: 3.2,
    min: 0.2,
    max: 8,
    step: 0.05,
  },
  horizon: {
    type: 'float',
    label: 'Horizon',
    default: 0.12,
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  ripple: {
    type: 'float',
    label: 'Onset ripple',
    default: 1,
    min: 0,
    max: 4,
    step: 0.01,
  },
  stars: {
    type: 'float',
    label: 'Stars',
    default: 0.8,
    min: 0,
    max: 2,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Glow',
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.01,
  },
} satisfies ParamSchema

class AuroraMode implements VisualMode {
  readonly id = 'aurora'
  readonly name = 'Aurora'
  readonly description =
    'Curtains of light folding over a dark horizon, each listening to its own slice of the spectrum.'
  readonly params: ParamSchema = auroraParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private ripple = 0

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
        uTime: { value: 0 },
        uAspect: { value: 1 },
        uCurtains: { value: 5 },
        uHeight: { value: 0.7 },
        uFold: { value: 2.4 },
        uWidth: { value: 0.16 },
        uLevel: { value: 0 },
        uRipple: { value: 0 },
        uGlow: { value: 0.7 },
        uStars: { value: 0.8 },
        uHorizon: { value: 0.12 },
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

    // Ripple decays rather than tracking onset directly, so a burst of onsets
    // reads as one travelling wave instead of strobing the curtains.
    this.ripple = Math.max(
      this.ripple * Math.exp(-signal.dt / 0.7),
      signal.onset * (params.ripple as number),
    )

    const u = material.uniforms
    u.uTime.value = signal.t * (calm ? 0.4 : 1)
    u.uAspect.value = ctx.width / Math.max(1, ctx.height)
    u.uCurtains.value = Math.max(1, Math.round(params.curtains as number))
    u.uHeight.value = params.height as number
    u.uFold.value = params.fold as number
    u.uWidth.value = params.width as number
    u.uLevel.value = signal.level
    u.uRipple.value = calm ? this.ripple * 0.3 : this.ripple
    u.uGlow.value = params.glow as number
    u.uStars.value = params.stars as number
    u.uHorizon.value = params.horizon as number

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

export function createAuroraMode(): VisualMode {
  return new AuroraMode()
}
