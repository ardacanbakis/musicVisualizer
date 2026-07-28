/**
 * Fireplace — a digital fire, with the colour under your control.
 *
 * Not a particle system. Fire is simulated here as a heat field on a feedback
 * buffer: each frame every texel samples slightly *below* itself, displaced
 * sideways by a noise field, and loses a little heat. That single rule —
 * advect upward, cool — produces licking flames, because the noise field is
 * what makes the rising column wander rather than climb straight up. Fuel is
 * injected along the bottom edge.
 *
 * Colour is deliberately decoupled from physics. Real fire colour comes from
 * blackbody radiation, which is beautiful but fixes you to orange; this maps
 * heat through either the palette or a hue you pick, so it can be a green fire
 * or a blue one without the motion changing at all.
 *
 * This is the mode most likely to be left running for hours, so the quiet
 * behaviour is the design target: with no audio at all the fire still burns
 * from its own noise, and audio only makes it flare.
 */
import * as THREE from 'three'
import type { Signal } from '../../signal/types'
import {
  COLOR_HELPERS,
  FULLSCREEN_VERTEX,
  HASH_HELPERS,
  SIMPLEX_NOISE,
} from '../glsl'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import { BAND_COUNT } from '../../signal/types'
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
  uniform float uCooling;
  uniform float uFuel;
  uniform float uLevel;
  uniform float uOnset;
  uniform float uAspect;
  uniform float uSpread;

  varying vec2 vUv;

  void main() {
    // Sample from below: this texel inherits the heat that was under it, which
    // is what makes the field rise.
    float rise = uRise * uDt;

    // Sideways displacement from a noise field that scrolls upward with the
    // flame. This is the whole trick — without it the column rises straight
    // and reads as a gradient, not as fire.
    vec2 noisePos = vec2(vUv.x * uAspect * 3.0, vUv.y * 2.0 - uTime * 0.55);
    float sway = snoise(vec3(noisePos, uTime * 0.35));
    float swayFine = snoise(vec3(noisePos * 2.6, uTime * 0.7));

    // Turbulence grows with height: the base of a flame is stable, the tip is
    // chaotic. A constant amount looks like a flag, not a fire.
    float height = vUv.y;
    float turb = uTurbulence * (0.15 + height * 1.5);

    vec2 offset = vec2((sway * 0.6 + swayFine * 0.4) * turb * 0.045, -rise);
    float heat = texture2D(uHeat, vUv + offset).r;

    // Cooling scales steeply with height. The steepness is what sets flame
    // height: heat decays as exp(-integral(cooling)/rise), so these constants
    // put the visible tip around 40-50% of the screen. Too shallow and the
    // fire is a slab of white filling the frame rather than tongues.
    heat -= uCooling * uDt * (0.3 + height * 2.2);

    // --- fuel along the bottom edge ---
    // Spectrum across the width: the fire burns hotter where the music is
    // loud in that part of the spectrum. Reads as the fire "listening"
    // without any part of it going dark and dead.
    float band = texture2D(uBands, vec2(vUv.x, 0.5)).r;

    // Two octaves of moving noise, sharpened. The sharpening matters: a bed
    // that is merely brighter and dimmer produces one continuous sheet of
    // flame, whereas real fire has cold gaps between separate tongues, and
    // the gaps are what make it read as fire.
    float bedA = snoise(vec3(vUv.x * 7.0 * uAspect, uTime * 1.1, 0.0)) * 0.5 + 0.5;
    float bedB = snoise(vec3(vUv.x * 17.0 * uAspect + 5.0, uTime * 1.9, 3.0)) * 0.5 + 0.5;
    float bedNoise = pow(bedA * 0.65 + bedB * 0.35, 1.4);

    // Scaled so even the hottest spot lands near 0.78 rather than clamping at
    // 1.0. Everything above ~0.8 maps to white in the ramp, so a bed that
    // saturates renders as a solid white slab with the flame shape lost
    // inside it — the structure only survives if the fuel stays off the rail.
    float bed = smoothstep(uSpread, 0.0, vUv.y);
    float fuel = uFuel * bed * (0.2 + bedNoise * 0.7) * (0.5 + band * 0.3 + uLevel * 0.2);

    // Onsets flare the whole bed briefly. Capped, because a fire that doubles
    // in brightness on every kick is a strobe with extra steps — and the
    // limiter would claw it back anyway, which looks worse than not doing it.
    fuel *= 1.0 + uOnset * 0.5;

    heat = max(heat, fuel);

    // Embers: rare bright specks near the base that survive a little longer.
    float ember = hash22(floor(vUv / uTexel * 0.5) + floor(uTime * 8.0)).x;
    if (ember > 0.9995 && vUv.y < 0.25) heat = max(heat, 0.85);

    gl_FragColor = vec4(clamp(heat, 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`

const RENDER_FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}

  uniform sampler2D uHeat;
  uniform sampler2D uPalette;
  uniform vec3 uBackground;
  uniform vec3 uTint;
  uniform float uUseTint;
  uniform float uGlow;
  uniform float uContrast;

  varying vec2 vUv;

  // Blackbody-ish ramp, used as the shape of the tinted gradient rather than
  // for its literal colour: dark red -> orange -> yellow -> white. Keeping
  // that luminance progression is what makes a green or blue fire still read
  // as fire rather than as a green smear.
  vec3 heatRamp(float t, vec3 tint) {
    float lo = smoothstep(0.0, 0.45, t);
    float mid = smoothstep(0.3, 0.75, t);
    float hi = smoothstep(0.78, 1.0, t);
    vec3 color = tint * lo;
    // Desaturate towards the hot end: the hottest part of any flame is white.
    color = mix(color, mix(tint, vec3(1.0), 0.55), mid);
    color = mix(color, vec3(1.0), hi * 0.55);
    return color;
  }

  void main() {
    float heat = texture2D(uHeat, vUv).r;
    float t = pow(clamp(heat, 0.0, 1.0), uContrast);

    vec3 flame;
    if (uUseTint > 0.5) {
      flame = heatRamp(t, uTint);
    } else {
      // Palette mode: the album or built-in palette supplies the colour,
      // sampled along its luminance ramp so hot still means bright.
      flame = ambSrgbToLinear(texture2D(uPalette, vec2(t, 0.5)).rgb);
    }

    // Emissive falloff so the fire lights the darkness around it a little.
    float bloom = smoothstep(0.015, 0.4, heat);
    vec3 color = uBackground + flame * bloom * (1.0 + uGlow * t * t);

    gl_FragColor = vec4(color, 1.0);
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
  height: {
    type: 'float',
    label: 'Flame height',
    default: 1,
    min: 0.3,
    max: 2.5,
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
  spread: {
    type: 'float',
    label: 'Bed depth',
    hint: 'How far up the screen the fuel bed reaches.',
    default: 0.12,
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
} satisfies ParamSchema

class FireplaceMode implements VisualMode {
  readonly id = 'fireplace'
  readonly name = 'Fireplace'
  readonly description =
    'A digital fire on a heat feedback buffer. Burns on its own in silence; the spectrum feeds the fuel bed.'
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
        uCooling: { value: 0.9 },
        uFuel: { value: 0.9 },
        uLevel: { value: 0 },
        uOnset: { value: 0 },
        uAspect: { value: 1 },
        uSpread: { value: 0.12 },
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
    ;(this.heatMaterial!.uniforms.uTexel.value as THREE.Vector2).set(
      1 / width,
      1 / height,
    )
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

    const u = heatMaterial.uniforms
    u.uHeat.value = heat.read.texture
    u.uTime.value = signal.t
    u.uDt.value = signal.dt
    // Rise and cooling are a pair: raising one without the other changes the
    // flame's height rather than its speed.
    u.uRise.value = 0.35 * (params.height as number) * (calm ? 0.6 : 1)
    u.uCooling.value = 0.9 / Math.max(0.3, params.height as number)
    u.uTurbulence.value = (params.turbulence as number) * (calm ? 0.4 : 1)
    u.uFuel.value = params.fuel as number
    u.uSpread.value = params.spread as number
    u.uLevel.value = signal.level
    u.uOnset.value = calm ? signal.onset * 0.3 : signal.onset
    u.uAspect.value = ctx.width / Math.max(1, ctx.height)
    ctx.blit(heatMaterial, heat.write)
    heat.swap()

    const background = signal.palette.background
    render.uniforms.uHeat.value = heat.read.texture
    ;(render.uniforms.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )
    const useTint = (params.colorSource as string) === 'custom'
    render.uniforms.uUseTint.value = useTint ? 1 : 0
    if (useTint) {
      // The colour picker hands us an sRGB hex string; setStyle with an
      // explicit colour space converts it into the linear working space.
      this.tintColor.setStyle(params.tint as string, THREE.SRGBColorSpace)
      ;(render.uniforms.uTint.value as THREE.Color).copy(this.tintColor)
    }
    render.uniforms.uGlow.value = params.glow as number
    render.uniforms.uContrast.value = params.contrast as number
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
