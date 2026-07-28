/**
 * Yin Yang — the symbol over a deep-space background, breathing with the music.
 *
 * The two dots are a sun and a moon. That is not decoration: in the symbol the
 * small dot in each lobe is the opposite colour to the lobe around it, which
 * is exactly the relationship a sun has to night and a moon has to day. So the
 * dark lobe's light dot becomes the sun, and the light lobe's dark dot becomes
 * the moon, and the symbol reads correctly without any change to its geometry.
 *
 * Construction notes:
 *
 * - **The division is built from two circles, not an S-curve.** A yin-yang is
 *   a disc split by two half-discs of half the radius sitting on the vertical
 *   diameter. Inside the upper one you are on the light side, inside the lower
 *   one the dark side, and elsewhere the vertical split decides. Three lines,
 *   exactly right, and no curve fitting.
 *
 * - **The side test is supersampled rather than antialiased analytically.**
 *   The dividing curve has no cheap closed-form signed distance, and getting
 *   one wrong shows up as a shimmering edge on the one shape the whole mode is
 *   about. Four rotated taps is cheaper than being clever and always correct.
 *
 * - **Backgrounds are variants, not decoration.** Starfield, galaxy and nebula
 *   are genuinely different pictures behind the same symbol; `void` exists
 *   because on a big panel in a dark room the symbol alone is often the best
 *   of the four.
 *
 * Ambient-first: with no audio the symbol still turns, the sun still breathes
 * and the stars still twinkle. Audio widens the corona and adds onset rings.
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
  uniform float uRotation;
  uniform float uSize;
  uniform float uLevel;
  uniform float uBass;
  uniform float uTreble;
  uniform float uOnset;
  uniform float uPulse;      // decaying onset ring radius
  uniform float uBackdrop;   // 0 stars, 1 galaxy, 2 nebula, 3 void
  uniform float uStarDensity;
  uniform float uGlow;
  uniform float uCorona;
  uniform float uTint;       // how much the symbol takes the palette's colour

  varying vec2 vUv;

  vec3 rampAt(float t) {
    return ambSrgbToLinear(texture2D(uPalette, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb);
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      total += snoise(vec3(p, uTime * 0.01)) * amplitude;
      p *= 2.03;
      amplitude *= 0.5;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Backdrops
  // -------------------------------------------------------------------------

  /**
   * Starfield. Stars are placed one per cell of a jittered grid and the 3x3
   * neighbourhood is searched, so a star sitting near a cell border still
   * contributes to the neighbouring cell instead of being clipped in half.
   */
  float starfield(vec2 p, float density) {
    vec2 grid = p * density;
    vec2 cell = floor(grid);
    vec2 local = fract(grid);
    float total = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 offset = vec2(float(x), float(y));
        vec2 h = hash22(cell + offset);
        // Sparse: most cells hold no star at all, or the sky reads as noise.
        if (h.x < 0.82) continue;
        vec2 position = offset + vec2(h.y, fract(h.x * 41.7));
        float d = length(local - position);
        float brightness = 0.35 + fract(h.x * 91.3) * 0.65;
        // Each star twinkles on its own period; a shared one pulses the whole
        // sky at once and looks like a fault rather than a sky.
        float twinkle = 0.6 + 0.4 * sin(uTime * (0.6 + h.y * 2.4) + h.x * 40.0);
        total += smoothstep(0.055, 0.0, d) * brightness * twinkle;
      }
    }
    return total;
  }

  /** Logarithmic-spiral galaxy with a bright core and dust modulation. */
  float galaxy(vec2 p) {
    float r = length(p);
    float angle = atan(p.y, p.x);
    // log(r) in the argument is what makes the arms logarithmic — the shape
    // real galaxies have. A linear term gives an Archimedean coil instead,
    // which reads as a cartoon swirl.
    float spiral = sin(2.0 * (angle + log(max(r, 0.02)) * 2.4) + uTime * 0.03);
    float arms = smoothstep(-0.15, 1.0, spiral) * exp(-r * 1.5);
    float core = exp(-r * r * 12.0) * 1.4;
    float dust = 0.55 + 0.45 * fbm(p * 2.4);
    return (arms * dust + core);
  }

  /** Slow fbm clouds. */
  float nebula(vec2 p) {
    float base = fbm(p * 1.4 + vec2(uTime * 0.008, 0.0));
    float detail = fbm(p * 3.7 - vec2(0.0, uTime * 0.011));
    float density = base * 0.65 + detail * 0.35;
    return smoothstep(-0.15, 0.85, density) * exp(-length(p) * 0.55);
  }

  // -------------------------------------------------------------------------
  // The symbol
  // -------------------------------------------------------------------------

  /**
   * Which side of the division a point falls on. 1 = light lobe, 0 = dark.
   * The argument is in symbol space where the outer radius is 1.
   */
  float side(vec2 p) {
    if (length(p - vec2(0.0, 0.5)) < 0.5) return 1.0;
    if (length(p + vec2(0.0, 0.5)) < 0.5) return 0.0;
    return p.x < 0.0 ? 1.0 : 0.0;
  }

  void main() {
    // Aspect-corrected, centred coordinates. y stays -0.5..0.5.
    vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);

    // ---- backdrop ----
    vec3 color = uBackground;

    if (uBackdrop < 0.5) {
      float s = starfield(p + vec2(uTime * 0.004, 0.0), uStarDensity);
      // Stars take colour from the top of the palette so they belong to the
      // scene rather than being generic white specks.
      color += rampAt(0.85) * s * (0.5 + uLevel * 0.5);
    } else if (uBackdrop < 1.5) {
      // Offset so the core is not directly behind the symbol — centred, the
      // brightest and most structured part of the galaxy is always occluded.
      float g = galaxy((p - vec2(0.26, -0.14)) * 1.8);
      color += rampAt(clamp(g * 0.8, 0.0, 1.0)) * g * (0.35 + uLevel * 0.4);
      color += rampAt(0.9) * starfield(p, uStarDensity * 0.6) * 0.35;
    } else if (uBackdrop < 2.5) {
      float n = nebula(p * 2.0);
      color += rampAt(clamp(0.25 + n * 0.7, 0.0, 1.0)) * n * (0.4 + uLevel * 0.35);
      color += rampAt(0.9) * starfield(p, uStarDensity * 0.5) * 0.3;
    }
    // uBackdrop >= 2.5 is 'void': background only.

    // ---- onset ring ----
    // An expanding ring launched by onsets. Reads as the symbol breathing out
    // rather than as a flash, which is what the limiter would clamp anyway.
    if (uPulse > 0.001) {
      float ringRadius = uPulse * 0.9;
      float ring = exp(-abs(length(p) - ringRadius) * 42.0);
      color += rampAt(0.75) * ring * (1.0 - uPulse) * 0.5;
    }

    // ---- symbol space ----
    float radius = uSize * (1.0 + uLevel * 0.04);
    float c = cos(uRotation), s = sin(uRotation);
    vec2 q = (mat2(c, -s, s, c) * p) / radius;

    float pixel = max(length(fwidth(q)), 1e-5);
    float disc = smoothstep(1.0 + pixel, 1.0 - pixel, length(q));

    if (disc > 0.001) {
      // Supersample the side test: the dividing curve has no cheap analytic
      // distance, and a mis-derived one shimmers on the one shape this mode
      // exists to draw.
      float e = pixel * 0.5;
      float lightness =
        (side(q + vec2( e,  e)) +
         side(q + vec2(-e,  e)) +
         side(q + vec2( e, -e)) +
         side(q + vec2(-e, -e))) * 0.25;

      vec3 darkTone  = mix(vec3(0.02, 0.02, 0.03), rampAt(0.12), uTint);
      vec3 lightTone = mix(vec3(0.93, 0.93, 0.95), rampAt(0.82), uTint);
      vec3 symbol = mix(darkTone, lightTone, lightness);

      // ---- sun, in the dark lobe ----
      vec2 sunCentre = vec2(0.0, -0.5);
      float sunDistance = length(q - sunCentre);
      float sunBody = smoothstep(0.17 + pixel, 0.17 - pixel, sunDistance);
      // Corona breathes with the bass and flares on onsets.
      float coronaWidth = 0.10 + uBass * 0.11 + uOnset * 0.06;
      float corona = exp(-max(sunDistance - 0.17, 0.0) / max(coronaWidth, 0.01));
      // Rays, rotating slowly against the symbol's own rotation so the two
      // motions do not lock together and look rigid.
      float rayAngle = atan(q.y - sunCentre.y, q.x - sunCentre.x);
      float rays = 0.72 + 0.28 * sin(rayAngle * 12.0 - uTime * 0.35);
      vec3 sunColor = mix(vec3(1.0, 0.86, 0.55), rampAt(0.95), uTint);

      symbol = mix(symbol, sunColor, sunBody);
      // Scaled down deliberately: the dark lobe has to stay dark or the
      // symbol stops reading as a yin-yang at all.
      symbol += sunColor * corona * rays * uCorona * (0.3 + uLevel * 0.45);

      // ---- moon, in the light lobe ----
      vec2 moonCentre = vec2(0.0, 0.5);
      float moonDistance = length(q - moonCentre);
      float moonDisc = smoothstep(0.17 + pixel, 0.17 - pixel, moonDistance);
      // Crescent: subtract a disc offset to one side. The offset drifts, so
      // the moon slowly waxes and wanes over a couple of minutes.
      float phase = sin(uTime * 0.045) * 0.13;
      float bite = smoothstep(0.165 + pixel, 0.165 - pixel, length(q - moonCentre - vec2(phase, 0.02)));
      float crescent = clamp(moonDisc - bite, 0.0, 1.0);
      vec3 moonColor = mix(vec3(0.06, 0.07, 0.12), rampAt(0.2), uTint);

      // The moon's body is dark against the light lobe; the crescent edge
      // catches a cool highlight that responds to the top of the spectrum.
      symbol = mix(symbol, moonColor, moonDisc);
      symbol += mix(vec3(0.7, 0.78, 1.0), rampAt(0.7), uTint)
              * crescent * (0.25 + uTreble * 0.7);

      color = mix(color, symbol, disc);

      // Outer rim glow, so the symbol sits in the space rather than on top of it.
      float rim = exp(-abs(length(q) - 1.0) * 14.0);
      color += rampAt(0.6) * rim * uGlow * (0.25 + uLevel * 0.5) * 0.35;
    } else {
      // Halo outside the disc, drawn only where the symbol is not.
      float halo = exp(-max(length(q) - 1.0, 0.0) * 5.0);
      color += rampAt(0.55) * halo * uGlow * 0.14 * (0.4 + uLevel * 0.6);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`

export const yinYangParams = {
  backdrop: {
    type: 'enum',
    label: 'Background',
    default: 'stars',
    options: [
      { value: 'stars', label: 'Starry night' },
      { value: 'galaxy', label: 'Galaxy' },
      { value: 'nebula', label: 'Nebula' },
      { value: 'void', label: 'Empty space' },
    ],
  },
  size: {
    type: 'float',
    label: 'Symbol size',
    default: 0.28,
    min: 0.08,
    max: 0.48,
    step: 0.005,
  },
  spin: {
    type: 'float',
    label: 'Spin',
    hint: 'Rotations per minute. Slow is the point.',
    default: 0.5,
    min: -4,
    max: 4,
    step: 0.05,
  },
  beatSpin: {
    type: 'float',
    label: 'Beat nudge',
    hint: 'Extra rotation on each onset.',
    default: 0.5,
    min: 0,
    max: 3,
    step: 0.01,
  },
  corona: {
    type: 'float',
    label: 'Sun corona',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Rim glow',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  tint: {
    type: 'float',
    label: 'Palette tint',
    hint: '0 keeps the symbol black and white; 1 takes the palette fully.',
    default: 0.45,
    min: 0,
    max: 1,
    step: 0.01,
  },
  stars: {
    type: 'float',
    label: 'Star density',
    default: 26,
    min: 6,
    max: 70,
    step: 1,
  },
} satisfies ParamSchema

const BACKDROPS: Record<string, number> = { stars: 0, galaxy: 1, nebula: 2, void: 3 }

class YinYangMode implements VisualMode {
  readonly id = 'yin-yang'
  readonly name = 'Yin Yang'
  readonly description =
    'The symbol turning in deep space, its two dots a sun and a moon that glow with the music.'
  readonly params: ParamSchema = yinYangParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private rotation = 0
  /** 0..1 expanding ring, launched by onsets. */
  private pulse = 0

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
        uRotation: { value: 0 },
        uSize: { value: 0.28 },
        uLevel: { value: 0 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uOnset: { value: 0 },
        uPulse: { value: 0 },
        uBackdrop: { value: 0 },
        uStarDensity: { value: 26 },
        uGlow: { value: 1 },
        uCorona: { value: 1 },
        uTint: { value: 0.45 },
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
    const bandCount = signal.bands.length

    // Averaged over ranges rather than sampled at one index, so neither the
    // corona nor the crescent twitches on a single frequency.
    let bass = 0
    const bassBands = Math.max(1, Math.floor(bandCount * 0.22))
    for (let i = 0; i < bassBands; i++) bass += signal.bands[i]
    bass /= bassBands

    let treble = 0
    const trebleStart = Math.floor(bandCount * 0.65)
    for (let i = trebleStart; i < bandCount; i++) treble += signal.bands[i]
    treble /= Math.max(1, bandCount - trebleStart)

    // Rotation: a steady drift plus a nudge on each onset, so it keeps time
    // without the jerkiness of driving it from beat phase directly.
    const rpm = (params.spin as number) * (calm ? 0.35 : 1)
    this.rotation += signal.dt * rpm * (Math.PI * 2) / 60
    this.rotation += signal.onset * signal.dt * (params.beatSpin as number) * (calm ? 0.3 : 1)

    // Ring pulse: onsets reset it to 0 and it expands to 1 over ~1.4s.
    if (signal.onset > 0.35 && this.pulse > 0.55) this.pulse = 0
    else if (signal.onset > 0.35 && this.pulse >= 1) this.pulse = 0
    this.pulse = Math.min(1, this.pulse + signal.dt / (calm ? 2.4 : 1.4))

    const u = material.uniforms
    u.uTime.value = signal.t
    u.uAspect.value = ctx.width / Math.max(1, ctx.height)
    u.uRotation.value = this.rotation
    u.uSize.value = params.size as number
    u.uLevel.value = signal.level
    u.uBass.value = bass
    u.uTreble.value = treble
    u.uOnset.value = calm ? signal.onset * 0.4 : signal.onset
    u.uPulse.value = this.pulse >= 1 ? 0 : this.pulse
    u.uBackdrop.value = BACKDROPS[params.backdrop as string] ?? 0
    u.uStarDensity.value = params.stars as number
    u.uGlow.value = params.glow as number
    u.uCorona.value = params.corona as number
    u.uTint.value = params.tint as number

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

export function createYinYangMode(): VisualMode {
  return new YinYangMode()
}
