/**
 * Lava lamp — metaballs with a convection cycle.
 *
 * Blobs are summed as a scalar field and the surface is the level set where
 * that field crosses a threshold. That is what makes them *merge*: two nearby
 * blobs raise the field between them above the threshold, and the surface
 * bridges. Drawing circles and blurring them does not do this, and the merge
 * is the entire visual identity of a lava lamp.
 *
 * The physics is faked but follows the real cycle, because that is what makes
 * it read as a lamp rather than as floating balls: a blob heats at the bottom,
 * becomes buoyant, rises, cools at the top, and sinks. Each blob runs that
 * cycle on its own period, so the lamp never repeats.
 *
 * Everything is evaluated per pixel in one pass — no feedback buffer. With a
 * dozen blobs that is cheaper than the ping-pong plumbing would be, and it
 * stays perfectly sharp at any resolution.
 */
import * as THREE from 'three'
import type { Signal } from '../../signal/types'
import { COLOR_HELPERS, FULLSCREEN_VERTEX } from '../glsl'
import { PaletteTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

/** Compile-time cap; the active count is a runtime uniform. */
const MAX_BLOBS = 16

const FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}

  #define MAX_BLOBS ${MAX_BLOBS}

  uniform vec3 uBlobs[MAX_BLOBS];   // xy = centre, z = radius
  uniform float uCount;
  uniform sampler2D uPalette;
  uniform vec3 uBackground;
  uniform float uAspect;
  uniform float uThreshold;
  uniform float uSoftness;
  uniform float uGlow;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);

    float field = 0.0;
    // Colour identity is accumulated *weighted by each blob's own field
    // contribution*, not taken from the nearest blob. Nearest-blob lookup
    // gives every pair of blobs a Voronoi boundary where the colour jumps,
    // and those straight seams are plainly visible across the merged
    // surface. Weighting makes the transition as smooth as the merge itself.
    float weightedId = 0.0;

    for (int i = 0; i < MAX_BLOBS; i++) {
      if (float(i) >= uCount) break;
      vec3 blob = uBlobs[i];
      vec2 d = p - blob.xy;
      float distanceSquared = dot(d, d);
      // Inverse-square falloff, the classic metaball kernel. The +1e-5 keeps
      // the centre finite instead of producing inf and then NaN.
      float contribution = (blob.z * blob.z) / (distanceSquared + 1e-5);
      field += contribution;
      weightedId += contribution * (float(i) / max(1.0, uCount - 1.0));
    }
    float blobId = field > 1e-5 ? weightedId / field : 0.0;

    // The level set. Softness widens the transition band; too tight and the
    // edge aliases badly, too wide and the blobs stop looking like liquid.
    float surface = smoothstep(uThreshold - uSoftness, uThreshold + uSoftness, field);

    // Interior shading from how far past the threshold we are, which reads as
    // thickness — the middle of a blob is denser than its edge.
    float depth = smoothstep(uThreshold, uThreshold * 2.6, field);

    float coord = clamp(blobId * 0.55 + depth * 0.45, 0.0, 1.0);
    vec3 ink = ambSrgbToLinear(texture2D(uPalette, vec2(coord, 0.5)).rgb);

    // A soft halo outside the surface, as if the lamp is lit from within.
    // Kept narrow: widen it and the blobs stop having a surface at all and
    // read as glowing gas rather than liquid.
    float halo = smoothstep(uThreshold * 0.65, uThreshold, field) * (1.0 - surface);

    vec3 color = uBackground;
    // Interior kept fairly flat. Leaning hard on the depth term here makes every
    // blob a radial gradient, which reads as a glowing orb rather than as a
    // body of liquid with a surface.
    color += ink * surface * (0.82 + depth * 0.3);
    color += ink * halo * uGlow * 0.35;

    gl_FragColor = vec4(color, 1.0);
  }
`

export const lavaLampParams = {
  count: {
    type: 'int',
    label: 'Blobs',
    default: 9,
    min: 3,
    max: MAX_BLOBS,
    step: 1,
  },
  size: {
    type: 'float',
    label: 'Blob size',
    default: 1,
    min: 0.4,
    max: 2.2,
    step: 0.01,
  },
  speed: {
    type: 'float',
    label: 'Convection speed',
    hint: 'How fast blobs complete a rise-and-sink cycle.',
    default: 1,
    min: 0.1,
    max: 3,
    step: 0.01,
  },
  wobble: {
    type: 'float',
    label: 'Bass wobble',
    hint: 'How much the low bands swell the blobs.',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  softness: {
    type: 'float',
    label: 'Edge softness',
    hint: 'Width of the surface transition. Wide values look like gas, not liquid.',
    default: 0.12,
    min: 0.02,
    max: 1.5,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Glow',
    default: 0.6,
    min: 0,
    max: 2,
    step: 0.01,
  },
} satisfies ParamSchema

interface Blob {
  /** Horizontal home position, 0..aspect. */
  x: number
  /** Seconds for one full rise-and-sink cycle. */
  period: number
  /** Offset into the cycle, so they do not move together. */
  phase: number
  /** Horizontal drift rate and amplitude. */
  driftRate: number
  driftAmount: number
  baseRadius: number
}

class LavaLampMode implements VisualMode {
  readonly id = 'lava-lamp'
  readonly name = 'Lava Lamp'
  readonly description =
    'Metaballs on a slow convection cycle. Blobs merge and separate as they rise and sink.'
  readonly params: ParamSchema = lavaLampParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private blobs: Blob[] = []
  private uniformData: THREE.Vector3[] = []
  /** Own clock, so speed changes ease in instead of making blobs jump. */
  private cycleTime = 0

  init(ctx: RenderContext): void {
    this.ctx = ctx

    // Deterministic layout: a fixed arrangement that looks considered, rather
    // than random placement that clumps half the blobs in one corner.
    this.blobs = []
    for (let i = 0; i < MAX_BLOBS; i++) {
      const golden = (i * 0.6180339887) % 1
      this.blobs.push({
        x: 0.12 + golden * 0.76,
        // Periods deliberately not in integer ratios, so the arrangement never
        // returns to a previous state.
        period: 14 + (i % 5) * 3.7 + golden * 5,
        phase: golden * 100,
        driftRate: 0.05 + golden * 0.09,
        driftAmount: 0.03 + golden * 0.05,
        // Sized so neighbouring blobs actually bridge. With the inverse-square
        // kernel at threshold 1, two blobs merge once their centres are within
        // ~2.8r; at the previous 0.055 they almost never got that close and the
        // lamp rendered as separate circles, which misses the entire point.
        baseRadius: 0.085 + ((i * 7) % 5) * 0.014,
      })
    }

    this.uniformData = Array.from({ length: MAX_BLOBS }, () => new THREE.Vector3())

    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBlobs: { value: this.uniformData },
        uCount: { value: 9 },
        uPalette: { value: this.palette.texture },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uAspect: { value: 1 },
        uThreshold: { value: 1.0 },
        uSoftness: { value: 0.35 },
        uGlow: { value: 0.8 },
        uTime: { value: 0 },
      },
    })
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const material = this.material
    if (!ctx || !material) return

    this.palette.update(signal.palette)

    const calm = ctx.reducedMotion
    const speed = (params.speed as number) * (calm ? 0.4 : 1)
    this.cycleTime += signal.dt * speed

    const aspect = ctx.width / Math.max(1, ctx.height)
    const count = Math.min(MAX_BLOBS, Math.round(params.count as number))
    const sizeScale = params.size as number

    // Bass swells the blobs. Averaged over the low quarter so a single
    // frequency cannot make them twitch.
    let bass = 0
    const bassBands = Math.max(1, Math.floor(signal.bands.length * 0.25))
    for (let i = 0; i < bassBands; i++) bass += signal.bands[i]
    bass /= bassBands
    const swell = 1 + bass * (params.wobble as number) * (calm ? 0.15 : 0.35)

    for (let i = 0; i < count; i++) {
      const blob = this.blobs[i]
      const t = (this.cycleTime + blob.phase) / blob.period
      const cycle = t - Math.floor(t)

      // Vertical position over one cycle. A raised cosine gives the blob a
      // pause at the top and bottom — the dwell is what makes it look like it
      // is heating and cooling rather than simply oscillating.
      const eased = 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2)
      const y = 0.12 + eased * 0.76

      // Horizontal drift, independent of the vertical cycle.
      const x =
        blob.x + Math.sin(this.cycleTime * blob.driftRate * 6.283 + blob.phase) * blob.driftAmount

      // Blobs squash slightly at the turning points, as a real one does when
      // it hits the top and spreads before sinking.
      const squash = 1 - 0.12 * Math.abs(Math.cos(cycle * Math.PI * 2))

      const target = this.uniformData[i]
      target.set(x * aspect, y, blob.baseRadius * sizeScale * swell * squash)
    }

    // Unused slots are pushed far off screen with zero radius. Cheaper and
    // safer than branching on count inside the inner loop for every pixel.
    for (let i = count; i < MAX_BLOBS; i++) this.uniformData[i].set(-10, -10, 0)

    const background = signal.palette.background
    material.uniforms.uCount.value = count
    material.uniforms.uAspect.value = aspect
    material.uniforms.uSoftness.value = params.softness as number
    material.uniforms.uGlow.value = params.glow as number
    material.uniforms.uTime.value = signal.t
    ;(material.uniforms.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )

    ctx.blit(material, null)
  }

  resize(): void {
    // Aspect is recomputed every frame; nothing to reallocate.
  }

  dispose(): void {
    this.material?.dispose()
    this.palette.dispose()
    this.material = null
    this.blobs = []
    this.uniformData = []
    this.ctx = null
  }
}

export function createLavaLampMode(): VisualMode {
  return new LavaLampMode()
}
