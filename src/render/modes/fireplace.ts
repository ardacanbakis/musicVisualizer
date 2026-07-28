/**
 * Fireplace — a digital fire, with the colour under your control.
 *
 * Fire is simulated as a heat field on a feedback buffer: each frame every
 * texel samples slightly *below* itself, displaced sideways, and loses heat.
 * Advect upward, cool, inject fuel at the base. No particles.
 *
 * Four things separate this from the first version, which rendered as a
 * burning horizon rather than a fire in a hearth:
 *
 * 1. **A hearth envelope.** Fuel is concentrated in the middle and falls away
 *    at the edges, so the fire has a location. A bed spanning the full width
 *    reads as the horizon being on fire, which is a different and much less
 *    cosy thing.
 *
 * 2. **Convergence.** Flames are pulled towards the fire's centre line as they
 *    rise, which is what entrained air does to a real flame. This is what
 *    produces tapering tongues instead of a rising slab; it is the single
 *    biggest contributor to it reading as fire.
 *
 * 3. **A coal bed.** A separate, near-static glow at the base that does not
 *    participate in the advection. Real fires are mostly embers, and the
 *    steady orange underneath is what makes the flickering above look
 *    anchored rather than free-floating.
 *
 * 4. **A vignette.** It should look like a fire in a dark room, so the corners
 *    fall away. Also keeps the mean frame luminance low, which matters for an
 *    ambient piece.
 *
 * Colour is deliberately decoupled from physics. Real fire colour is blackbody
 * radiation, beautiful but fixed to orange; this maps heat through either a
 * chosen hue or the palette, while keeping the dark -> saturated -> white
 * luminance progression that makes a green or blue fire still read as fire.
 */
import * as THREE from 'three'
import type { Signal } from '../../signal/types'
import { BAND_COUNT } from '../../signal/types'
import {
  COLOR_HELPERS,
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

/** The heat field runs below canvas resolution; flames are soft anyway. */
const RESOLUTION_DIVISOR = 2

const HEAT_FRAGMENT = /* glsl */ `
  precision highp float;

  ${SIMPLEX_NOISE}
  ${HASH_HELPERS}

  uniform sampler2D uHeat;
  uniform sampler2D uBands;
  uniform vec2 uTexel;
  uniform float uTime;
  uniform float uDt;
  uniform float uRise;
  uniform float uTurbulence;
  uniform float uConverge;
  uniform float uCooling;
  uniform float uFuel;
  uniform float uWidth;
  uniform float uLevel;
  uniform float uOnset;
  uniform float uAspect;
  uniform float uSpread;

  varying vec2 vUv;

  void main() {
    float height = vUv.y;

    // --- lateral motion ---
    // Noise that scrolls upward with the flame, so the wander travels with the
    // heat instead of the flame sliding through a stationary pattern.
    vec2 noisePos = vec2(vUv.x * uAspect * 3.0, vUv.y * 2.0 - uTime * 0.55);
    float sway = snoise(vec3(noisePos, uTime * 0.35));
    float swayFine = snoise(vec3(noisePos * 2.6, uTime * 0.7));

    // Turbulence grows with height: the base of a flame is stable, the tip is
    // chaotic. A constant amount looks like a flag.
    float turb = uTurbulence * (0.1 + height * 1.8);
    float lateral = (sway * 0.6 + swayFine * 0.4) * turb;

    // Convergence towards the centre line, increasing with height. This is
    // what tapers the flames into tongues.
    float converge = -(vUv.x - 0.5) * uConverge * height;

    // Both displacements are rates in UV per second, so they must end up the
    // same order of magnitude as uRise. Getting this wrong is not subtle: a
    // lateral step several times the vertical one samples from most of a
    // screen away every frame and smears the flame out of existence.
    float lateralRate = lateral * 0.15;
    float convergeRate = converge * 0.5;
    vec2 offset = vec2((lateralRate + convergeRate) * uDt, -uRise * uDt);
    float heat = texture2D(uHeat, vUv + offset).r;

    // Cooling scales steeply with height, which is what sets the flame's
    // visible tip — heat decays as exp(-integral(cooling)/rise).
    heat -= uCooling * uDt * (0.3 + height * 2.4);

    // --- fuel bed ---
    float band = texture2D(uBands, vec2(vUv.x, 0.5)).r;

    // Two octaves, sharpened, so the bed has cold gaps. A bed that is merely
    // brighter and dimmer burns as one continuous sheet; the gaps are what
    // separate it into individual tongues.
    float bedA = snoise(vec3(vUv.x * 7.0 * uAspect, uTime * 1.1, 0.0)) * 0.5 + 0.5;
    float bedB = snoise(vec3(vUv.x * 17.0 * uAspect + 5.0, uTime * 1.9, 3.0)) * 0.5 + 0.5;
    float bedNoise = pow(bedA * 0.65 + bedB * 0.35, 1.4);

    // Hearth envelope: the fire has a middle and edges rather than spanning
    // the whole frame.
    float centred = (vUv.x - 0.5) / max(uWidth * 0.5, 0.02);
    float hearth = exp(-centred * centred * 2.2);

    float bed = smoothstep(uSpread, 0.0, vUv.y);
    // Tuned against *typical* values, not peak ones. bedNoise averages ~0.38
    // after the sharpening and the band term averages well under 1, so a
    // scaling that looks right for the maximum leaves the ordinary case at
    // about a third of the intended heat — which renders as a barely visible
    // smudge. Peak still lands just under 1.0 and only when everything
    // coincides.
    float fuel = uFuel * bed * hearth * (0.4 + bedNoise * 0.6)
               * (0.7 + band * 0.25 + uLevel * 0.15);

    // Onsets flare the bed. Capped: a fire that doubles in brightness on every
    // kick is a strobe with extra steps, and the limiter would claw it back
    // anyway, which looks worse than never doing it.
    fuel *= 1.0 + uOnset * 0.45;

    heat = max(heat, fuel);

    // Embers: rare specks lifted from the bed that survive longer than the
    // flame around them.
    float ember = hash22(floor(vUv / uTexel * 0.5) + floor(uTime * 8.0)).x;
    if (ember > 0.9994 && vUv.y < 0.3 && hearth > 0.35) heat = max(heat, 0.7);

    gl_FragColor = vec4(clamp(heat, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`

const RENDER_FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}
  ${SIMPLEX_NOISE}

  uniform sampler2D uHeat;
  uniform sampler2D uPalette;
  uniform vec3 uBackground;
  uniform vec3 uTint;
  uniform float uUseTint;
  uniform float uGlow;
  uniform float uContrast;
  uniform float uCoals;
  uniform float uWidth;
  uniform float uSpread;
  uniform float uAspect;
  uniform float uTime;
  uniform float uVignette;

  varying vec2 vUv;

  // Blackbody-shaped ramp, used for its luminance progression rather than its
  // literal colour: dark -> saturated -> desaturated -> white.
  vec3 heatRamp(float t, vec3 tint) {
    float lo = smoothstep(0.0, 0.45, t);
    float mid = smoothstep(0.3, 0.75, t);
    float hi = smoothstep(0.8, 1.0, t);
    vec3 color = tint * lo;
    color = mix(color, mix(tint, vec3(1.0), 0.5), mid);
    color = mix(color, vec3(1.0), hi * 0.5);
    return color;
  }

  void main() {
    float heat = texture2D(uHeat, vUv).r;
    float t = pow(clamp(heat, 0.0, 1.0), uContrast);

    vec3 flameColor;
    if (uUseTint > 0.5) {
      flameColor = heatRamp(t, uTint);
    } else {
      flameColor = ambSrgbToLinear(texture2D(uPalette, vec2(t, 0.5)).rgb);
    }

    float bloom = smoothstep(0.01, 0.3, heat);
    vec3 color = flameColor * bloom * (1.0 + uGlow * t * t);

    // --- coal bed ---
    // A slow, nearly static glow beneath the flames. Deliberately not part of
    // the advection: embers are what a fire mostly is, and a steady base is
    // what stops the flickering above from looking like it is floating.
    float centred = (vUv.x - 0.5) / max(uWidth * 0.5, 0.02);
    float hearth = exp(-centred * centred * 2.0);
    float coalBand = smoothstep(uSpread * 1.35, 0.0, vUv.y);
    float coalNoise = snoise(vec3(vUv.x * 9.0 * uAspect, vUv.y * 22.0, uTime * 0.5)) * 0.5 + 0.5;
    float coal = coalBand * hearth * uCoals * (0.35 + coalNoise * 0.85);
    vec3 coalColor = uUseTint > 0.5 ? heatRamp(0.45 + coalNoise * 0.2, uTint)
                                    : ambSrgbToLinear(texture2D(uPalette, vec2(0.5, 0.5)).rgb);
    color += coalColor * coal * 0.8;

    // --- vignette ---
    // A fire in a dark room, not a fire filling a rectangle. Also holds the
    // mean frame luminance down, which an ambient piece wants.
    vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
    float vignette = 1.0 - uVignette * smoothstep(0.25, 0.95, length(v));
    color *= max(vignette, 0.0);

    gl_FragColor = vec4(uBackground + color, 1.0);
  }
`

export const fireplaceParams = {
  colorSource: {
    type: 'enum',
    label: 'Flame colour',
    hint: 'Custom uses the colour below; Palette follows the active palette or album art.',
    default: 'custom',
    options: [
      { value: 'custom', label: 'Custom colour' },
      { value: 'palette', label: 'Follow palette' },
    ],
  },
  tint: {
    type: 'color',
    label: 'Colour',
    hint: 'Only used when flame colour is set to Custom.',
    default: '#ff6a1a',
  },
  width: {
    type: 'float',
    label: 'Fire width',
    hint: 'How much of the screen the hearth spans.',
    default: 0.55,
    min: 0.15,
    max: 1.6,
    step: 0.01,
  },
  height: {
    type: 'float',
    label: 'Flame height',
    default: 1,
    min: 0.3,
    max: 2.5,
    step: 0.01,
  },
  converge: {
    type: 'float',
    label: 'Taper',
    hint: 'How strongly flames pull towards the centre as they rise.',
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.01,
  },
  turbulence: {
    type: 'float',
    label: 'Turbulence',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  fuel: {
    type: 'float',
    label: 'Fuel',
    hint: 'How hot the base of the fire burns.',
    default: 0.9,
    min: 0.2,
    max: 1,
    step: 0.01,
  },
  coals: {
    type: 'float',
    label: 'Coal bed',
    default: 0.8,
    min: 0,
    max: 2,
    step: 0.01,
  },
  spread: {
    type: 'float',
    label: 'Bed depth',
    default: 0.1,
    min: 0.02,
    max: 0.5,
    step: 0.005,
  },
  contrast: {
    type: 'float',
    label: 'Contrast',
    default: 1.1,
    min: 0.4,
    max: 3,
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
  vignette: {
    type: 'float',
    label: 'Vignette',
    default: 0.55,
    min: 0,
    max: 1,
    step: 0.01,
  },
} satisfies ParamSchema

class FireplaceMode implements VisualMode {
  readonly id = 'fireplace'
  readonly name = 'Fireplace'
  readonly description =
    'A digital fire in a hearth, with a coal bed and any flame colour you like. Burns on its own in silence.'
  readonly params: ParamSchema = fireplaceParams

  private ctx: RenderContext | null = null
  private heat: PingPong | null = null
  private heatMaterial: THREE.ShaderMaterial | null = null
  private renderMaterial: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private tintColor = new THREE.Color()

  init(ctx: RenderContext): void {
    this.ctx = ctx

    this.heatMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: HEAT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uHeat: { value: null },
        uBands: { value: this.bands.texture },
        uTexel: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uRise: { value: 0.35 },
        uTurbulence: { value: 1 },
        uConverge: { value: 0.5 },
        uCooling: { value: 0.75 },
        uFuel: { value: 0.9 },
        uWidth: { value: 0.55 },
        uLevel: { value: 0 },
        uOnset: { value: 0 },
        uAspect: { value: 1 },
        uSpread: { value: 0.1 },
      },
    })

    this.renderMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: RENDER_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uHeat: { value: null },
        uPalette: { value: this.palette.texture },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uTint: { value: new THREE.Color(1, 0.42, 0.1) },
        uUseTint: { value: 1 },
        uGlow: { value: 0.7 },
        uContrast: { value: 1.1 },
        uCoals: { value: 0.8 },
        uWidth: { value: 0.55 },
        uSpread: { value: 0.1 },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uVignette: { value: 0.55 },
      },
    })

    this.allocate()
  }

  private allocate(): void {
    const ctx = this.ctx
    if (!ctx) return
    const width = Math.max(64, Math.floor(ctx.width / RESOLUTION_DIVISOR))
    const height = Math.max(64, Math.floor(ctx.height / RESOLUTION_DIVISOR))
    this.heat?.dispose()
    this.heat = ctx.createPingPong({
      width,
      height,
      type: THREE.HalfFloatType,
      filter: THREE.LinearFilter,
    })
    this.heat.clear(0, 0, 0, 1)
    ;(this.heatMaterial!.uniforms.uTexel.value as THREE.Vector2).set(1 / width, 1 / height)
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const heat = this.heat
    const heatMaterial = this.heatMaterial
    const render = this.renderMaterial
    if (!ctx || !heat || !heatMaterial || !render) return

    this.bands.update(signal.bands)
    this.palette.update(signal.palette)

    const calm = ctx.reducedMotion
    const aspect = ctx.width / Math.max(1, ctx.height)
    const flameHeight = params.height as number

    const u = heatMaterial.uniforms
    u.uHeat.value = heat.read.texture
    u.uTime.value = signal.t
    u.uDt.value = signal.dt
    // Rise and cooling are a pair: changing one alone changes the flame's
    // height rather than its speed.
    u.uRise.value = 0.35 * flameHeight * (calm ? 0.6 : 1)
    u.uCooling.value = 0.75 / Math.max(0.3, flameHeight)
    u.uTurbulence.value = (params.turbulence as number) * (calm ? 0.4 : 1)
    u.uConverge.value = params.converge as number
    u.uFuel.value = params.fuel as number
    u.uWidth.value = params.width as number
    u.uSpread.value = params.spread as number
    u.uLevel.value = signal.level
    u.uOnset.value = calm ? signal.onset * 0.3 : signal.onset
    u.uAspect.value = aspect
    ctx.blit(heatMaterial, heat.write)
    heat.swap()

    const background = signal.palette.background
    const r = render.uniforms
    r.uHeat.value = heat.read.texture
    ;(r.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )
    const useTint = (params.colorSource as string) === 'custom'
    r.uUseTint.value = useTint ? 1 : 0
    if (useTint) {
      // The colour picker gives an sRGB hex string; setStyle with an explicit
      // colour space converts it into the linear working space.
      this.tintColor.setStyle(params.tint as string, THREE.SRGBColorSpace)
      ;(r.uTint.value as THREE.Color).copy(this.tintColor)
    }
    r.uGlow.value = params.glow as number
    r.uContrast.value = params.contrast as number
    r.uCoals.value = params.coals as number
    r.uWidth.value = params.width as number
    r.uSpread.value = params.spread as number
    r.uVignette.value = params.vignette as number
    r.uAspect.value = aspect
    r.uTime.value = signal.t
    ctx.blit(render, null)
  }

  resize(): void {
    this.allocate()
  }

  dispose(): void {
    this.heat?.dispose()
    this.heatMaterial?.dispose()
    this.renderMaterial?.dispose()
    this.palette.dispose()
    this.bands.dispose()
    this.heat = null
    this.heatMaterial = null
    this.renderMaterial = null
    this.ctx = null
  }
}

export function createFireplaceMode(): VisualMode {
  return new FireplaceMode()
}
