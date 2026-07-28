/**
 * A palette as a 1D texture, so shaders can sample it with a single lookup
 * instead of carrying an array uniform whose length would have to be fixed at
 * compile time (album-art palettes do not have a fixed number of stops).
 *
 * Shared by every mode. This is a utility, not a mode — modes importing this is
 * fine; modes importing each other is not.
 */
import * as THREE from 'three'
import { sampleRamp } from '../signal/types'
import type { RGB } from '../signal/types'
import type { Palette } from '../signal/types'

const RESOLUTION = 128

export class PaletteTexture {
  readonly texture: THREE.DataTexture
  // Explicit <ArrayBuffer>: a bare `Uint8Array` annotation widens to
  // ArrayBufferLike under TS 5.7+, which the DataTexture signature rejects.
  private data: Uint8Array<ArrayBuffer>
  private lastPalette: Palette | null = null

  constructor() {
    this.data = new Uint8Array(RESOLUTION * 4)
    this.texture = new THREE.DataTexture(this.data, RESOLUTION, 1, THREE.RGBAFormat)
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    // Texels are 8-bit sRGB — better precision in the darks than 8-bit linear,
    // which is where an ambient palette spends most of its range. Tagged
    // NoColorSpace so three leaves them alone: raw ShaderMaterials get no
    // automatic decode, so modes call `srgbToLinear` explicitly. See glsl.ts.
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.needsUpdate = true
  }

  /**
   * Re-upload only when the palette object actually changed. During a
   * crossfade `mixPalette` returns a fresh object every frame so this uploads
   * every frame, which is correct; when the palette is stable it uploads never.
   */
  update(palette: Palette): void {
    if (palette === this.lastPalette) return
    this.lastPalette = palette
    const data = this.data
    for (let i = 0; i < RESOLUTION; i++) {
      const [r, g, b] = sampleRamp(palette, i / (RESOLUTION - 1))
      const offset = i * 4
      data[offset] = Math.round(Math.max(0, Math.min(1, r)) * 255)
      data[offset + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255)
      data[offset + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255)
      data[offset + 3] = 255
    }
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * A fixed, explicitly-ordered colour ramp as a 1D texture.
 *
 * Unlike PaletteTexture this does not sort, interpolate or derive anything —
 * texel i is colour i. Needed where the order carries meaning that luminance
 * ordering would destroy, e.g. the Winamp analyser gradient, which runs green
 * to red bottom-to-top and is not monotonic in brightness.
 */
export class RampTexture {
  readonly texture: THREE.DataTexture

  constructor(colors: RGB[], smooth = false) {
    const data = new Uint8Array(colors.length * 4)
    colors.forEach((color, i) => {
      data[i * 4] = Math.round(Math.max(0, Math.min(1, color[0])) * 255)
      data[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, color[1])) * 255)
      data[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, color[2])) * 255)
      data[i * 4 + 3] = 255
    })
    this.texture = new THREE.DataTexture(data, colors.length, 1, THREE.RGBAFormat)
    // Nearest by default: this ramp is a list of discrete colours, and
    // interpolating between them defeats the point of choosing them.
    const filter = smooth ? THREE.LinearFilter : THREE.NearestFilter
    this.texture.minFilter = filter
    this.texture.magFilter = filter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * The time-domain waveform as a 1D float texture, for oscilloscope modes.
 * Values are -1..1, so this needs a float texture rather than 8-bit.
 */
export class WaveformTexture {
  readonly texture: THREE.DataTexture
  private data: Float32Array<ArrayBuffer>

  constructor(size: number) {
    this.data = new Float32Array(size)
    this.texture = new THREE.DataTexture(this.data, size, 1, THREE.RedFormat, THREE.FloatType)
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.needsUpdate = true
  }

  update(waveform: Float32Array): void {
    this.data.set(waveform)
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}

/**
 * The band array as a 1D float texture. Also shared — every mode wants the
 * spectrum available in a shader.
 */
export class BandTexture {
  readonly texture: THREE.DataTexture
  private data: Float32Array<ArrayBuffer>

  constructor(bandCount: number) {
    this.data = new Float32Array(bandCount)
    this.texture = new THREE.DataTexture(
      this.data,
      bandCount,
      1,
      THREE.RedFormat,
      THREE.FloatType,
    )
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.wrapS = THREE.ClampToEdgeWrapping
    this.texture.wrapT = THREE.ClampToEdgeWrapping
    this.texture.needsUpdate = true
  }

  update(bands: Float32Array): void {
    this.data.set(bands)
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
  }
}
