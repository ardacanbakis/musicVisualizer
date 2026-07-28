/**
 * Geometric tiling — Truchet tiles that subdivide and reorient on onsets.
 *
 * A Truchet tile is two quarter-circle arcs joining the midpoints of adjacent
 * edges. Because every tile presents the same four connection points, any
 * random mix of rotations produces continuous curves across the whole grid —
 * you get sprawling interlocking loops out of a per-cell coin flip, with no
 * global planning at all. That emergent continuity is the reason this pattern
 * has been interesting since the 1700s.
 *
 * Two additions over the classic:
 *
 * - **Subdivision.** Each cell independently decides, from the band it listens
 *   to, whether to split into four smaller tiles. Loud regions of the spectrum
 *   become dense detail, quiet ones stay large and calm. The arcs still meet
 *   at the boundaries because the connection points are shared regardless of
 *   scale.
 *
 * - **Quasiperiodic mode.** The grid is sampled through an irrational rotation
 *   so the tiling never repeats. Worth having because a periodic grid on a
 *   wall display becomes very obvious after ten minutes of looking at it.
 *
 * Reorientation is smoothed, not instant: a tile that flips between frames
 * makes the whole picture pop, so each cell eases towards its new rotation.
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
  uniform vec3 uBackground;
  uniform float uAspect;
  uniform float uScale;
  uniform float uThickness;
  uniform float uSubdivide;
  uniform float uQuasi;
  uniform float uRotation;
  uniform float uTime;
  uniform float uLevel;
  uniform float uGlow;
  uniform vec2 uResolution;

  varying vec2 vUv;

  /**
   * Distance to the two quarter-circle arcs of a Truchet tile.
   * The flip argument selects which diagonal pair the arcs connect.
   */
  float truchetDistance(vec2 p, float flip) {
    // Mirror the cell for the alternate orientation. One line, and it is the
    // whole of the Truchet trick.
    if (flip > 0.5) p.x = 1.0 - p.x;
    // Arcs are centred on two opposite corners with radius 0.5, so they meet
    // the edge midpoints exactly and join across cell boundaries.
    float a = abs(length(p - vec2(0.0, 0.0)) - 0.5);
    float b = abs(length(p - vec2(1.0, 1.0)) - 0.5);
    return min(a, b);
  }

  void main() {
    vec2 p = vec2(vUv.x * uAspect, vUv.y);

    // Slow global rotation keeps the grid from being locked to the screen
    // edges, which is what makes a tiling read as wallpaper.
    float c = cos(uRotation), s = sin(uRotation);
    p = mat2(c, -s, s, c) * p;

    // Quasiperiodic sampling: shear by an irrational amount so cell
    // coordinates never recur exactly.
    p += uQuasi * vec2(p.y * 0.6180339887, p.x * 0.4142135624);

    vec2 grid = p * uScale;
    vec2 cell = floor(grid);
    vec2 local = fract(grid);

    // Each cell listens to one band, chosen by hash so neighbours respond to
    // different frequencies and the grid animates as a texture rather than as
    // horizontal stripes.
    float bandSlot = hash22(cell + 3.7).x;
    float band = texture2D(uBands, vec2(bandSlot, 0.5)).r;

    // --- subdivision ---
    // Split into four when this cell's band is loud enough. The threshold is
    // per-cell so cells cross it at different times instead of the whole grid
    // flipping at once.
    float splitBias = hash22(cell + 11.3).y;
    float depth = 0.0;
    if (uSubdivide > 0.01 && band * uSubdivide > 0.35 + splitBias * 0.5) {
      grid = p * uScale * 2.0;
      cell = floor(grid);
      local = fract(grid);
      depth = 1.0;
    }

    // --- orientation ---
    // Target flip comes from a hash that advances with onsets, so tiles
    // reorient on the beat. Easing between the two states rather than
    // switching avoids a full-frame pop.
    float seedA = hash22(cell).x;
    float seedB = hash22(cell + 97.0).x;
    float blend = smoothstep(0.0, 1.0, fract(uTime));
    float flip = mix(step(0.5, seedA), step(0.5, seedB), blend);

    float d = truchetDistance(local, step(0.5, flip));

    // Line width in screen pixels, so strokes stay even as cells subdivide.
    float cellPixels = uResolution.y / (uScale * mix(1.0, 2.0, depth));
    float pixel = 1.5 / max(cellPixels, 1.0);
    float thickness = uThickness * 0.06 * (0.75 + band * 0.5);

    float line = smoothstep(thickness + pixel, thickness - pixel, d);

    float coord = clamp(bandSlot * 0.5 + band * 0.5, 0.0, 1.0);
    vec3 ink = ambSrgbToLinear(texture2D(uPalette, vec2(coord, 0.5)).rgb);

    vec3 color = uBackground;
    color = mix(color, ink * (0.6 + band * 0.7 + uLevel * 0.3), line);

    // A soft bloom just outside the stroke, which keeps thin lines from
    // looking harsh on a large display.
    float bloom = exp(-max(d - thickness, 0.0) * 40.0);
    color += ink * bloom * uGlow * 0.25 * (0.4 + band * 0.6);

    gl_FragColor = vec4(color, 1.0);
  }
`

export const tilingParams = {
  scale: {
    type: 'float',
    label: 'Grid scale',
    hint: 'Cells across the short edge.',
    default: 7,
    min: 2,
    max: 28,
    step: 0.5,
  },
  thickness: {
    type: 'float',
    label: 'Line weight',
    default: 1,
    min: 0.2,
    max: 3,
    step: 0.01,
  },
  subdivide: {
    type: 'float',
    label: 'Subdivision',
    hint: 'How readily loud cells split into four.',
    default: 1,
    min: 0,
    max: 2,
    step: 0.01,
  },
  quasi: {
    type: 'float',
    label: 'Quasiperiodic',
    hint: 'Shear the grid by an irrational amount so it never repeats.',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
  },
  drift: {
    type: 'float',
    label: 'Rotation drift',
    hint: 'Slow rotation of the whole grid.',
    default: 0.4,
    min: 0,
    max: 2,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Glow',
    default: 0.8,
    min: 0,
    max: 2,
    step: 0.01,
  },
} satisfies ParamSchema

class TilingMode implements VisualMode {
  readonly id = 'tiling'
  readonly name = 'Geometric Tiling'
  readonly description =
    'Truchet tiles forming continuous curves, subdividing where the spectrum is loud and reorienting on onsets.'
  readonly params: ParamSchema = tilingParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private rotation = 0
  /** Advances on onsets; its fractional part drives the flip crossfade. */
  private orientation = 0

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
        uAspect: { value: 1 },
        uScale: { value: 7 },
        uThickness: { value: 1 },
        uSubdivide: { value: 1 },
        uQuasi: { value: 0 },
        uRotation: { value: 0 },
        uTime: { value: 0 },
        uLevel: { value: 0 },
        uGlow: { value: 0.8 },
        uResolution: { value: new THREE.Vector2(1, 1) },
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
    this.rotation += signal.dt * (params.drift as number) * 0.02 * (calm ? 0.3 : 1)

    // Onsets push the reorientation crossfade forward. It always advances a
    // little on its own so the pattern keeps changing in a silent room —
    // otherwise this mode is a still image with no audio, which fails the
    // "must look good when nothing is happening" bar.
    const idleRate = calm ? 0.04 : 0.09
    this.orientation += signal.dt * idleRate + signal.onset * signal.dt * (calm ? 0.6 : 2.2)

    const u = material.uniforms
    u.uAspect.value = ctx.width / Math.max(1, ctx.height)
    u.uScale.value = params.scale as number
    u.uThickness.value = params.thickness as number
    u.uSubdivide.value = params.subdivide as number
    u.uQuasi.value = params.quasi as number
    u.uGlow.value = params.glow as number
    u.uRotation.value = this.rotation
    u.uTime.value = this.orientation
    u.uLevel.value = signal.level
    ;(u.uResolution.value as THREE.Vector2).set(ctx.width, ctx.height)

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
    // Resolution is read from the context every frame.
  }

  dispose(): void {
    this.material?.dispose()
    this.palette.dispose()
    this.bands.dispose()
    this.material = null
    this.ctx = null
  }
}

export function createTilingMode(): VisualMode {
  return new TilingMode()
}
