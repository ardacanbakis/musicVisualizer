/**
 * Winamp classic — the 1997 main-window visualiser, scaled up.
 *
 * Two displays, exactly as the original had them: a block spectrum analyser
 * with falling peak markers, and a one-pixel oscilloscope. The details that
 * make it recognisable rather than merely "some bars":
 *
 * - **The colours are the real ones.** CLASSIC_VISCOLOR below is Winamp's
 *   own viscolor.txt from the base skin, in its original order: red at the
 *   top of a bar through orange and yellow to green at the bottom, which is
 *   not a luminance ramp and cannot be produced by the app's palette system.
 *   Hence RampTexture, which preserves order instead of sorting.
 *
 * - **Everything is quantised to a virtual pixel grid.** The original vis
 *   window was 76x16 actual pixels. Drawing smooth bars at 4K and calling it
 *   Winamp misses the entire point; the chunkiness *is* the aesthetic. The
 *   analyser's blocks, the gaps between them and the scope trace are all
 *   snapped to the same grid.
 *
 * - **Peak markers fall at a fixed rate**, independent of the bar under them.
 *   They hang in the air after a transient and drift down. Getting this wrong
 *   (e.g. decaying them proportionally) is the most common way a copy of this
 *   visualiser looks subtly off.
 *
 * The band array is only 32 wide, so bar values are interpolated up to the
 * requested bar count rather than sampled — 32 hard steps stretched across 75
 * bars reads as a staircase.
 */
import * as THREE from 'three'
import { BAND_COUNT, WAVEFORM_SIZE } from '../../signal/types'
import type { RGB, Signal } from '../../signal/types'
import { COLOR_HELPERS, FULLSCREEN_VERTEX } from '../glsl'
import { PaletteTexture, RampTexture, WaveformTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

/**
 * Winamp's classic viscolor.txt, entries 2..17 — the analyser gradient.
 * Listed here bottom-of-bar first (green) to top (red), which is the reverse
 * of the file's own order.
 */
const CLASSIC_VISCOLOR: RGB[] = [
  [24 / 255, 132 / 255, 8 / 255],
  [41 / 255, 148 / 255, 0 / 255],
  [49 / 255, 156 / 255, 8 / 255],
  [57 / 255, 181 / 255, 16 / 255],
  [50 / 255, 190 / 255, 16 / 255],
  [41 / 255, 206 / 255, 16 / 255],
  [148 / 255, 222 / 255, 33 / 255],
  [189 / 255, 222 / 255, 41 / 255],
  [214 / 255, 181 / 255, 33 / 255],
  [222 / 255, 165 / 255, 24 / 255],
  [198 / 255, 123 / 255, 8 / 255],
  [214 / 255, 115 / 255, 0 / 255],
  [214 / 255, 102 / 255, 0 / 255],
  [214 / 255, 90 / 255, 0 / 255],
  [206 / 255, 41 / 255, 16 / 255],
  [239 / 255, 49 / 255, 16 / 255],
]

const MAX_BARS = 128

const FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}

  uniform sampler2D uBars;      // r = value, g = peak
  uniform sampler2D uWave;
  uniform sampler2D uRamp;
  uniform float uBarCount;
  uniform float uBarTexels;   // width of uBars, which is MAX_BARS not uBarCount
  uniform float uBlocks;
  uniform float uDisplay;       // 0 analyser, 1 scope, 2 both
  uniform float uBarGap;        // 0..1 of a bar's width
  uniform float uBlockGap;      // 0..1 of a block's height
  uniform float uShowPeaks;
  uniform vec2  uGrid;          // virtual pixel resolution
  uniform vec3  uBackground;
  uniform float uGlow;

  varying vec2 vUv;

  vec3 rampAt(float t) {
    return ambSrgbToLinear(texture2D(uRamp, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb);
  }

  /** Block analyser occupying the vertical range [lo, hi] of the screen. */
  vec3 analyser(vec2 uv, float lo, float hi) {
    float y = (uv.y - lo) / max(hi - lo, 1e-4);
    if (y < 0.0 || y > 1.0) return vec3(0.0);

    float barIndex = floor(uv.x * uBarCount);
    // Address by the texture's real width. The bar texture is allocated at
    // MAX_BARS and only the first uBarCount texels are written each frame, so
    // dividing by uBarCount here reads past the filled region for every bar
    // beyond the first few — which renders as content in the left third of
    // the screen and black everywhere else.
    vec2 bar = texture2D(uBars, vec2((barIndex + 0.5) / uBarTexels, 0.5)).rg;

    // Gap between bars, measured in bar-widths so it holds at any bar count.
    float withinBar = fract(uv.x * uBarCount);
    if (withinBar > 1.0 - uBarGap) return vec3(0.0);

    float blockIndex = floor(y * uBlocks);
    float withinBlock = fract(y * uBlocks);
    // Gap between stacked blocks — the horizontal scan lines that make the
    // bars read as stacks of LEDs rather than solid columns.
    if (withinBlock > 1.0 - uBlockGap) return vec3(0.0);

    float blockBase = blockIndex / uBlocks;
    vec3 color = vec3(0.0);

    if (blockBase < bar.r) {
      color = rampAt(blockIndex / max(uBlocks - 1.0, 1.0));
    }

    // Peak marker: one block, white, sitting at the held maximum. Drawn even
    // where the bar itself has fallen away beneath it.
    if (uShowPeaks > 0.5 && bar.g > 0.001) {
      float peakBlock = floor(bar.g * uBlocks);
      if (abs(blockIndex - peakBlock) < 0.5 && blockBase >= bar.r) {
        color = vec3(0.72);
      }
    }
    return color;
  }

  /** One-pixel oscilloscope occupying the vertical range [lo, hi]. */
  vec3 scope(vec2 uv, float lo, float hi) {
    float mid = (lo + hi) * 0.5;
    float halfHeight = (hi - lo) * 0.5;

    float amplitude = texture2D(uWave, vec2(uv.x, 0.5)).r;
    float traceY = mid + amplitude * halfHeight * 0.9;

    // Connect to the previous columnrather than plotting isolated points.
    // Winamp drew vertical segments between consecutive samples; plotting one
    // pixel per column leaves gaps wherever the waveform moves faster than a
    // pixel per column, and the trace breaks into dots on any steep edge.
    float previousX = max(uv.x - 1.0 / uGrid.x, 0.0);
    float previousAmplitude = texture2D(uWave, vec2(previousX, 0.5)).r;
    float previousY = mid + previousAmplitude * halfHeight * 0.9;

    // One virtual pixel thick, so the trace stays chunky like the original
    // rather than becoming a hairline on a big display.
    float pixelY = 1.0 / uGrid.y;
    float low = min(traceY, previousY) - pixelY * 0.5;
    float high = max(traceY, previousY) + pixelY * 0.5;
    if (uv.y < low || uv.y > high) return vec3(0.0);

    // Winamp tinted the trace by amplitude. Reusing the analyser ramp keeps
    // the two displays visually related.
    return rampAt(abs(amplitude) * 0.9);
  }

  void main() {
    // Snap to the virtual pixel grid before anything else, so every element
    // lands on the same lattice and nothing is half-lit.
    vec2 uv = (floor(vUv * uGrid) + 0.5) / uGrid;

    vec3 color = vec3(0.0);
    if (uDisplay < 0.5) {
      color = analyser(uv, 0.0, 1.0);
    } else if (uDisplay < 1.5) {
      color = scope(uv, 0.0, 1.0);
    } else {
      // Stacked: scope above, analyser below, with a gap between them.
      color = analyser(uv, 0.0, 0.55) + scope(uv, 0.62, 1.0);
    }

    // Slight bloom so it does not look flat on a modern panel. Kept small —
    // the original had none, and too much turns it into a different mode.
    vec3 lit = color * (1.0 + uGlow);
    gl_FragColor = vec4(uBackground + lit, 1.0);
  }
`

export const winampParams = {
  display: {
    type: 'enum',
    label: 'Display',
    default: 'analyzer',
    options: [
      { value: 'analyzer', label: 'Spectrum analyser' },
      { value: 'scope', label: 'Oscilloscope' },
      { value: 'both', label: 'Both' },
    ],
  },
  colors: {
    type: 'enum',
    label: 'Colours',
    hint: 'Classic is Winamp’s original viscolor gradient.',
    default: 'classic',
    options: [
      { value: 'classic', label: 'Classic Winamp' },
      { value: 'palette', label: 'Follow palette' },
    ],
  },
  bars: {
    type: 'int',
    label: 'Bars',
    default: 40,
    min: 8,
    max: MAX_BARS,
    step: 1,
  },
  blocks: {
    type: 'int',
    label: 'Blocks per bar',
    hint: 'Vertical resolution of the analyser. 16 is the original.',
    default: 16,
    min: 4,
    max: 48,
    step: 1,
  },
  chunkiness: {
    type: 'float',
    label: 'Chunkiness',
    hint: 'Size of the virtual pixel. Higher is more authentically low-res.',
    default: 1,
    min: 0.25,
    max: 4,
    step: 0.05,
  },
  peaks: {
    type: 'bool',
    label: 'Peak markers',
    default: true,
  },
  peakFall: {
    type: 'float',
    label: 'Peak fall speed',
    hint: 'Screen heights per second.',
    default: 0.55,
    min: 0.05,
    max: 3,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Glow',
    default: 0.15,
    min: 0,
    max: 1.5,
    step: 0.01,
  },
} satisfies ParamSchema

class WinampMode implements VisualMode {
  readonly id = 'winamp'
  readonly name = 'Winamp Classic'
  readonly description =
    'The 1997 block analyser and oscilloscope, with the original viscolor gradient and falling peak markers.'
  readonly params: ParamSchema = winampParams

  private ctx: RenderContext | null = null
  private material: THREE.ShaderMaterial | null = null
  private classicRamp = new RampTexture(CLASSIC_VISCOLOR)
  private palette = new PaletteTexture()
  private waveform = new WaveformTexture(WAVEFORM_SIZE)

  private barTexture: THREE.DataTexture | null = null
  private barData = new Float32Array(MAX_BARS * 2)
  private peaks = new Float32Array(MAX_BARS)
  private activeBars = 0

  init(ctx: RenderContext): void {
    this.ctx = ctx

    // RG float: r = current value, g = held peak. One texture rather than two
    // keeps the shader to a single fetch per fragment.
    this.barTexture = new THREE.DataTexture(
      this.barData,
      MAX_BARS,
      1,
      THREE.RGFormat,
      THREE.FloatType,
    )
    this.barTexture.minFilter = THREE.NearestFilter
    this.barTexture.magFilter = THREE.NearestFilter
    this.barTexture.needsUpdate = true

    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBars: { value: this.barTexture },
        uWave: { value: this.waveform.texture },
        uRamp: { value: this.classicRamp.texture },
        uBarCount: { value: 40 },
        uBarTexels: { value: MAX_BARS },
        uBlocks: { value: 16 },
        uDisplay: { value: 0 },
        uBarGap: { value: 0.22 },
        uBlockGap: { value: 0.28 },
        uShowPeaks: { value: 1 },
        uGrid: { value: new THREE.Vector2(320, 180) },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uGlow: { value: 0.15 },
      },
    })
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const material = this.material
    const barTexture = this.barTexture
    if (!ctx || !material || !barTexture) return

    const barCount = Math.min(MAX_BARS, Math.max(4, Math.round(params.bars as number)))
    if (barCount !== this.activeBars) {
      this.activeBars = barCount
      this.peaks.fill(0)
    }

    const bands = signal.bands
    const fall = (params.peakFall as number) * signal.dt * (ctx.reducedMotion ? 0.5 : 1)

    for (let i = 0; i < barCount; i++) {
      // Interpolate across the band array rather than nearest-sampling it:
      // 32 bands stretched over 75 bars would otherwise be a visible staircase.
      const position = (i / Math.max(1, barCount - 1)) * (BAND_COUNT - 1)
      const low = Math.floor(position)
      const high = Math.min(BAND_COUNT - 1, low + 1)
      const blend = position - low
      const value = bands[low] * (1 - blend) + bands[high] * blend

      // Peak hold: jumps up instantly, falls at a constant rate. Constant is
      // the important part — a proportional decay makes peaks hang forever on
      // tall bars and vanish instantly on short ones.
      const peak = Math.max(value, this.peaks[i] - fall)
      this.peaks[i] = peak

      this.barData[i * 2] = value
      this.barData[i * 2 + 1] = peak
    }
    barTexture.needsUpdate = true

    this.waveform.update(signal.waveform)
    this.palette.update(signal.palette)

    const display = params.display as string
    const u = material.uniforms
    u.uBarCount.value = barCount
    u.uBlocks.value = Math.max(2, Math.round(params.blocks as number))
    u.uDisplay.value = display === 'scope' ? 1 : display === 'both' ? 2 : 0
    u.uShowPeaks.value = params.peaks ? 1 : 0
    u.uGlow.value = params.glow as number
    u.uRamp.value =
      (params.colors as string) === 'palette' ? this.palette.texture : this.classicRamp.texture

    // Virtual pixel grid, derived from the real resolution so the chunk size
    // is consistent across displays rather than tied to the pixel count.
    const chunk = Math.max(0.25, params.chunkiness as number)
    const gridY = Math.max(24, Math.round(180 / chunk))
    const gridX = Math.max(32, Math.round(gridY * (ctx.width / Math.max(1, ctx.height))))
    ;(u.uGrid.value as THREE.Vector2).set(gridX, gridY)

    const background = signal.palette.background
    ;(u.uBackground.value as THREE.Color).setRGB(
      // The classic visualiser was on pure black. Following the palette's
      // background here would tint it, which looks wrong for this mode.
      (params.colors as string) === 'palette' ? background[0] : 0,
      (params.colors as string) === 'palette' ? background[1] : 0,
      (params.colors as string) === 'palette' ? background[2] : 0,
      THREE.SRGBColorSpace,
    )

    ctx.blit(material, null)
  }

  resize(): void {
    // The grid is recomputed from the context every frame.
  }

  dispose(): void {
    this.material?.dispose()
    this.barTexture?.dispose()
    this.classicRamp.dispose()
    this.palette.dispose()
    this.waveform.dispose()
    this.material = null
    this.barTexture = null
    this.ctx = null
  }
}

export function createWinampMode(): VisualMode {
  return new WinampMode()
}
