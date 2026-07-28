/**
 * Spectrum bars — the deliberately trivial mode.
 *
 * Its job is to prove the contract end to end: a mode that touches every part
 * of `Signal` (bands, level, onset, beat phase, palette) with no cleverness in
 * the way, so if something looks wrong you know it is the signal, not the
 * shader. It is also the reference for what a mode file looks like, which is
 * why it is commented past the point the visual itself deserves.
 *
 * It stays in the registry after the real modes land — it is the fastest way to
 * tell whether the audio pipeline or a mode is at fault.
 */
import * as THREE from 'three'
import { BAND_COUNT } from '../../signal/types'
import type { Signal } from '../../signal/types'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform sampler2D uBands;
  uniform sampler2D uPalette;
  uniform vec3  uBackground;
  uniform float uBandCount;
  uniform float uGap;
  uniform float uMirror;
  uniform float uGlow;
  uniform float uLevel;
  uniform float uOnset;
  uniform float uBeatPhase;
  uniform float uShowBeat;
  uniform vec2  uResolution;

  varying vec2 vUv;

  void main() {
    float n = uBandCount;
    float index = floor(vUv.x * n);
    float withinBar = fract(vUv.x * n);

    // Sample the band at its texel centre so linear filtering doesn't bleed
    // neighbouring bands into each other.
    float value = texture2D(uBands, vec2((index + 0.5) / n, 0.5)).r;

    // Mirror folds the bar around the vertical centre, which reads much calmer
    // than bars growing off the floor — worth having as the default for a
    // screen someone is not looking directly at.
    float y = mix(vUv.y, abs(vUv.y - 0.5) * 2.0, uMirror);

    // Antialias the bar's top edge in pixel units, so it stays soft at any
    // resolution instead of shimmering.
    float pixel = 1.5 / uResolution.y;
    float fill = smoothstep(value + pixel, value - pixel, y);

    // Same treatment horizontally for the gap between bars.
    float halfGap = uGap * 0.5;
    float pixelX = 1.5 / (uResolution.x / n);
    float mask =
      smoothstep(halfGap - pixelX, halfGap + pixelX, withinBar) *
      smoothstep(1.0 - halfGap + pixelX, 1.0 - halfGap - pixelX, withinBar);

    vec3 barColor = texture2D(uPalette, vec2(index / max(1.0, n - 1.0), 0.5)).rgb;

    vec3 color = uBackground;
    color = mix(color, barColor, fill * mask);

    // A soft bloom at the tip of each bar. Keeps the picture alive when the
    // bars themselves are barely moving.
    float tip = exp(-abs(y - value) * 26.0);
    color += barColor * tip * mask * uGlow * (0.35 + uLevel * 0.65);

    // Onset lift, deliberately tiny. A full-frame flash on every kick drum is
    // exactly the strobing this app is not allowed to do.
    color += barColor * uOnset * 0.06;

    // Optional beat tick along the bottom edge, for verifying the beat clock.
    if (uShowBeat > 0.5) {
      float tickWidth = 0.004;
      float d = abs(vUv.x - uBeatPhase);
      float tick = smoothstep(tickWidth, 0.0, d) * step(vUv.y, 0.012);
      color = mix(color, vec3(1.0), tick * 0.8);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`

export const barsParams = {
  gap: {
    type: 'float',
    label: 'Bar gap',
    hint: 'Fraction of each slot left empty.',
    default: 0.25,
    min: 0,
    max: 0.8,
    step: 0.01,
  },
  mirror: {
    type: 'bool',
    label: 'Mirror',
    hint: 'Grow bars from the centre line instead of the floor.',
    default: true,
  },
  glow: {
    type: 'float',
    label: 'Tip glow',
    default: 0.6,
    min: 0,
    max: 2,
    step: 0.01,
  },
  showBeat: {
    type: 'bool',
    label: 'Beat tick',
    hint: 'Show the beat-phase marker along the bottom edge.',
    default: false,
    group: 'Debug',
  },
} satisfies ParamSchema

class BarsMode implements VisualMode {
  readonly id = 'bars'
  readonly name = 'Spectrum Bars'
  readonly description =
    'Plain log-spaced spectrum bars. The reference mode — use it to tell whether a problem is in the audio or in a shader.'
  readonly params: ParamSchema = barsParams

  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private ctx: RenderContext | null = null

  init(ctx: RenderContext): void {
    this.ctx = ctx
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBands: { value: this.bands.texture },
        uPalette: { value: this.palette.texture },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uBandCount: { value: BAND_COUNT },
        uGap: { value: 0.25 },
        uMirror: { value: 1 },
        uGlow: { value: 0.6 },
        uLevel: { value: 0 },
        uOnset: { value: 0 },
        uBeatPhase: { value: 0 },
        uShowBeat: { value: 0 },
        uResolution: { value: new THREE.Vector2(ctx.width, ctx.height) },
      },
    })
  }

  frame(signal: Signal, params: ParamValues): void {
    if (!this.material || !this.ctx) return

    this.bands.update(signal.bands)
    this.palette.update(signal.palette)

    const uniforms = this.material.uniforms
    const background = signal.palette.background
    ;(uniforms.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )
    uniforms.uGap.value = params.gap as number
    uniforms.uMirror.value = params.mirror ? 1 : 0
    uniforms.uGlow.value = params.glow as number
    uniforms.uShowBeat.value = params.showBeat ? 1 : 0
    uniforms.uLevel.value = signal.level
    uniforms.uOnset.value = signal.onset
    uniforms.uBeatPhase.value = signal.beatPhase

    this.ctx.blit(this.material, null)
  }

  resize(width: number, height: number): void {
    if (!this.material) return
    ;(this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height)
  }

  dispose(): void {
    this.material?.dispose()
    this.material = null
    this.palette.dispose()
    this.bands.dispose()
    this.ctx = null
  }
}

export function createBarsMode(): VisualMode {
  return new BarsMode()
}
