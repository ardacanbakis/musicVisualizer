/**
 * The shared render stage.
 *
 * One `WebGLRenderer` for the whole app, one full-screen quad, and one
 * ping-pong helper. Modes get this as their `RenderContext`.
 *
 * The ping-pong helper lives here rather than in each mode on purpose. Both
 * reaction-diffusion and the flow-field trails need feedback buffers, and every
 * mode reinventing "two render targets and a swap" is how a codebase like this
 * rots — you end up with four subtly different resize and dispose paths, and
 * the one that forgets to dispose is the one that kills an overnight run.
 */
import * as THREE from 'three'
import type { PingPong, PingPongOptions, RenderContext } from './types'

/** Retina panels will happily hand you 3. Above 2 costs a lot and shows nothing. */
export const MAX_DPR = 2

class PingPongPair implements PingPong {
  private a: THREE.WebGLRenderTarget
  private b: THREE.WebGLRenderTarget
  private flipped = false

  constructor(
    private renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
    options: PingPongOptions,
  ) {
    const settings: THREE.RenderTargetOptions = {
      type: options.type ?? THREE.HalfFloatType,
      minFilter: options.filter ?? THREE.LinearFilter,
      magFilter: options.filter ?? THREE.LinearFilter,
      wrapS: options.wrap ?? THREE.ClampToEdgeWrapping,
      wrapT: options.wrap ?? THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    }
    this.a = new THREE.WebGLRenderTarget(width, height, settings)
    this.b = new THREE.WebGLRenderTarget(width, height, settings)
  }

  get read(): THREE.WebGLRenderTarget {
    return this.flipped ? this.b : this.a
  }

  get write(): THREE.WebGLRenderTarget {
    return this.flipped ? this.a : this.b
  }

  swap(): void {
    this.flipped = !this.flipped
  }

  setSize(width: number, height: number): void {
    this.a.setSize(width, height)
    this.b.setSize(width, height)
  }

  clear(r = 0, g = 0, b = 0, a = 1): void {
    const previousTarget = this.renderer.getRenderTarget()
    const previousColor = new THREE.Color()
    this.renderer.getClearColor(previousColor)
    const previousAlpha = this.renderer.getClearAlpha()

    this.renderer.setClearColor(new THREE.Color(r, g, b), a)
    for (const target of [this.a, this.b]) {
      this.renderer.setRenderTarget(target)
      this.renderer.clear(true, false, false)
    }

    this.renderer.setRenderTarget(previousTarget)
    this.renderer.setClearColor(previousColor, previousAlpha)
  }

  dispose(): void {
    this.a.dispose()
    this.b.dispose()
  }
}

export class Stage implements RenderContext {
  readonly renderer: THREE.WebGLRenderer
  width = 1
  height = 1
  dpr = 1

  private quadScene = new THREE.Scene()
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private quadGeometry = new THREE.PlaneGeometry(2, 2)
  private quadMesh: THREE.Mesh
  private placeholder = new THREE.MeshBasicMaterial()
  private pingPongs = new Set<PingPongPair>()

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // every mode here is post-process style; MSAA buys nothing
      alpha: false,
      powerPreference: 'high-performance',
      // Needed for frame capture: without it the drawing buffer is undefined
      // after compositing and toBlob() returns black.
      preserveDrawingBuffer: true,
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.autoClear = false

    this.quadMesh = new THREE.Mesh(this.quadGeometry, this.placeholder)
    this.quadMesh.frustumCulled = false
    this.quadScene.add(this.quadMesh)
  }

  /** @param cssWidth/@param cssHeight in CSS pixels; dpr is capped internally. */
  setSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.dpr = Math.min(MAX_DPR, Math.max(1, devicePixelRatio))
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(cssWidth, cssHeight, false)
    this.width = Math.max(1, Math.round(cssWidth * this.dpr))
    this.height = Math.max(1, Math.round(cssHeight * this.dpr))
  }

  createPingPong(options: PingPongOptions = {}): PingPong {
    const pair = new PingPongPair(
      this.renderer,
      options.width ?? this.width,
      options.height ?? this.height,
      options,
    )
    this.pingPongs.add(pair)
    const self = this
    // Wrap dispose so the stage stops tracking it. Modes are required to
    // dispose their own buffers; this set is a safety net for stage teardown,
    // not a licence for a mode to skip cleanup.
    const original = pair.dispose.bind(pair)
    pair.dispose = () => {
      self.pingPongs.delete(pair)
      original()
    }
    return pair
  }

  blit(material: THREE.Material, target: THREE.WebGLRenderTarget | null = null): void {
    this.quadMesh.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.quadScene, this.quadCamera)
    this.renderer.setRenderTarget(null)
  }

  /** Clear the canvas to a colour. Modes that fully cover the screen can skip this. */
  clear(color: THREE.ColorRepresentation, alpha = 1): void {
    this.renderer.setClearColor(color, alpha)
    this.renderer.setRenderTarget(null)
    this.renderer.clear(true, true, false)
  }

  dispose(): void {
    for (const pair of [...this.pingPongs]) pair.dispose()
    this.quadGeometry.dispose()
    this.placeholder.dispose()
    this.quadScene.clear()
    this.renderer.dispose()
  }
}
