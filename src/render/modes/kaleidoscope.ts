/**
 * Kaleidoscope — a flowing noise field folded through radial mirror symmetry.
 *
 * The whole mode is one idea: take an ordinary, fairly unremarkable animated
 * field and view it through N mirrored wedges. Symmetry does the work. A field
 * that looks like drifting fog on its own becomes an endlessly elaborating
 * ornament the moment it is folded, because the eye reads the repetition as
 * design rather than noise.
 *
 * Two details that separate this from a naive fold:
 *
 * - **The fold mirrors alternate wedges.** Rotating a wedge N times gives a
 *   pinwheel with a visible seam at every boundary, because the two sides of
 *   each seam are unrelated. Mirroring every other wedge makes the pattern
 *   continuous across the seam, which is what a real kaleidoscope does and the
 *   only way the joins disappear.
 *
 * - **The radial coordinate is warped, not just the angle.** Folding angle
 *   alone leaves everything strung out along rays. A slow log-spiral twist in
 *   the radius pulls the pattern around the centre so it reads as depth.
 *
 * Ambient-first: the field drifts on its own clock, so with no audio at all
 * this is a slowly evolving ornament. Audio pushes the twist and the segment
 * count, and onsets snap a fresh rotation.
 */
import * as THREE from 'three'
import { BAND_COUNT } from '../../signal/types'
import type { Signal } from '../../signal/types'
import { COLOR_HELPERS, FULLSCREEN_VERTEX, SIMPLEX_NOISE } from '../glsl'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

const FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}
  ${SIMPLEX_NOISE}

  uniform sampler2D uBands;
  uniform sampler2D uPalette;
  uniform vec3  uBackground;
  uniform float uTime;
  uniform float uAspect;
  uniform float uSegments;
  uniform float uZoom;
  uniform float uTwist;
  uniform float uRotation;
  uniform float uDetail;
  uniform float uLevel;
  uniform float uBass;
  uniform float uGlow;
  uniform float uContrast;

  varying vec2 vUv;

  vec3 rampAt(float t) {
    return ambSrgbToLinear(texture2D(uPalette, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb);
  }

  float fbm(vec2 p, float octaves) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 6; i++) {
      if (float(i) >= octaves) break;
      total += snoise(vec3(p, uTime * 0.05)) * amplitude;
      p = p * 2.02 + 7.3;
      amplitude *= 0.55;
    }
    return total;
  }

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);

    float radius = length(p);
    float angle = atan(p.y, p.x) + uRotation;

    // --- the fold ---
    float wedge = 6.2831853 / max(uSegments, 2.0);
    float folded = mod(angle, wedge);
    // Mirror every other wedge so the pattern is continuous across each seam.
    // Without this the joins are visible as hard radial lines.
    folded = abs(folded - wedge * 0.5);

    // --- radial warp ---
    // A log-spiral twist: pulls the pattern around the centre instead of
    // leaving it strung out along straight rays.
    float twisted = folded + log(max(radius, 0.008)) * uTwist;

    vec2 q = vec2(cos(twisted), sin(twisted)) * radius * uZoom;

    float field = fbm(q, uDetail);
    // Second sample at a different scale, offset by the bass, so low end
    // reshapes the ornament rather than only brightening it.
    field += fbm(q * 1.9 + vec2(uBass * 1.4, -uBass * 0.9), uDetail - 1.0) * 0.5;

    float shade = clamp(field * 0.5 + 0.5, 0.0, 1.0);
    shade = pow(shade, uContrast);

    // The band this radius listens to: the centre responds to bass, the
    // outside to treble, which makes the spectrum legible as rings.
    float band = texture2D(uBands, vec2(clamp(radius * 2.0, 0.0, 1.0), 0.5)).r;

    vec3 color = uBackground;
    // Raised to a power rather than offset by a constant. A constant floor
    // lights every pixel in the frame — the pattern was beautiful and the
    // screen was a lamp, which fails the one rule this app has.
    float intensity = pow(shade, 2.0);
    color += rampAt(shade) * intensity * 1.25 * (0.55 + band * 0.75 + uLevel * 0.35);

    // Ridge highlight where the field crosses its midpoint — this is what
    // gives the ornament its filigree edges instead of soft blobs.
    float ridge = 1.0 - abs(shade - 0.5) * 2.0;
    color += rampAt(0.9) * pow(max(ridge, 0.0), 6.0) * uGlow * 0.6;

    // Fade the very centre: all wedges meet there and the detail collapses to
    // a singularity that reads as a hot pinprick.
    color *= smoothstep(0.0, 0.06, radius);

    // Vignette. Without it the ornament runs flat to all four edges and the
    // frame has no centre of attention.
    color *= 1.0 - 0.55 * smoothstep(0.22, 0.78, radius);

    gl_FragColor = vec4(color, 1.0);
  }
`

export const kaleidoscopeParams = {
  segments: {
    type: 'int',
    label: 'Segments',
    hint: 'Mirrored wedges. Even numbers feel more formal.',
    default: 8,
    min: 2,
    max: 24,
    step: 1,
  },
  zoom: {
    type: 'float',
    label: 'Zoom',
    default: 3.2,
    min: 0.5,
    max: 12,
    step: 0.1,
  },
  twist: {
    type: 'float',
    label: 'Twist',
    hint: 'Log-spiral warp of the radius. 0 gives straight rays.',
    default: 0.35,
    min: -1.5,
    max: 1.5,
    step: 0.01,
  },
  detail: {
    type: 'int',
    label: 'Detail',
    hint: 'Noise octaves. Higher costs more.',
    default: 4,
    min: 1,
    max: 6,
    step: 1,
  },
  spin: {
    type: 'float',
    label: 'Spin',
    default: 0.6,
    min: -4,
    max: 4,
    step: 0.05,
  },
  onsetTurn: {
    type: 'float',
    label: 'Onset turn',
    hint: 'How far an onset kicks the rotation.',
    default: 0.6,
    min: 0,
    max: 3,
    step: 0.01,
  },
  contrast: {
    type: 'float',
    label: 'Contrast',
    default: 1.6,
    min: 0.3,
    max: 3,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Filigree',
    default: 0.8,
    min: 0,
    max: 2.5,
    step: 0.01,
  },
} satisfies ParamSchema

class KaleidoscopeMode implements VisualMode {
  readonly id = 'kaleidoscope'
  readonly name = 'Kaleidoscope'
  readonly description =
    'A drifting noise field folded through mirrored wedges. Symmetry turns fog into ornament.'
  readonly params: ParamSchema = kaleidoscopeParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private rotation = 0

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
        uSegments: { value: 8 },
        uZoom: { value: 3.2 },
        uTwist: { value: 0.35 },
        uRotation: { value: 0 },
        uDetail: { value: 4 },
        uLevel: { value: 0 },
        uBass: { value: 0 },
        uGlow: { value: 0.8 },
        uContrast: { value: 1.3 },
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

    let bass = 0
    const bassBands = Math.max(1, Math.floor(signal.bands.length * 0.22))
    for (let i = 0; i < bassBands; i++) bass += signal.bands[i]
    bass /= bassBands

    this.rotation +=
      signal.dt * (params.spin as number) * 0.12 * (calm ? 0.3 : 1) +
      signal.onset * signal.dt * (params.onsetTurn as number) * (calm ? 0.25 : 1)

    const u = material.uniforms
    u.uTime.value = signal.t * (calm ? 0.4 : 1)
    u.uAspect.value = ctx.width / Math.max(1, ctx.height)
    u.uSegments.value = Math.max(2, Math.round(params.segments as number))
    u.uZoom.value = params.zoom as number
    u.uTwist.value = params.twist as number
    u.uRotation.value = this.rotation
    u.uDetail.value = Math.max(1, Math.round(params.detail as number))
    u.uLevel.value = signal.level
    u.uBass.value = bass
    u.uGlow.value = params.glow as number
    u.uContrast.value = params.contrast as number

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

export function createKaleidoscopeMode(): VisualMode {
  return new KaleidoscopeMode()
}
