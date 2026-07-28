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
    // The ramp is authored in sRGB; telling three that means it converts to
    // linear on sample and the round-trip through outputColorSpace is correct.
    this.texture.colorSpace = THREE.SRGBColorSpace
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
