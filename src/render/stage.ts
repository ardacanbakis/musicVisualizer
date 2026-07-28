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
import { LuminanceLimiter } from './luminanceLimiter'
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
  reducedMotion = false

  private limiter: LuminanceLimiter

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
    // Linear, not sRGB: three only auto-encodes for its built-in materials,
    // and every shader in this app is a raw ShaderMaterial. Leaving this on
    // sRGB would imply an encode that never happens. The limiter's present
    // pass does the one explicit encode — see glsl.ts for the convention.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.autoClear = false

    this.quadMesh = new THREE.Mesh(this.quadGeometry, this.placeholder)
    this.quadMesh.frustumCulled = false
    this.quadScene.add(this.quadMesh)

    this.limiter = new LuminanceLimiter(
      this.renderer,
      (material, target) => this.rawBlit(material, target),
      1,
      1,
    )
  }

  /** @param cssWidth/@param cssHeight in CSS pixels; dpr is capped internally. */
  setSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.dpr = Math.min(MAX_DPR, Math.max(1, devicePixelRatio))
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(cssWidth, cssHeight, false)
    this.width = Math.max(1, Math.round(cssWidth * this.dpr))
    this.height = Math.max(1, Math.round(cssHeight * this.dpr))
    this.limiter.setSize(this.width, this.height)
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

  /**
   * Draw a full-screen quad. `target` of null means "the output", which is the
   * scene buffer rather than the canvas — everything a mode draws goes through
   * the luminance limiter before it reaches the glass, and a mode has no way
   * to address the canvas directly. That is deliberate.
   */
  blit(material: THREE.Material, target: THREE.WebGLRenderTarget | null = null): void {
    this.rawBlit(material, target ?? this.limiter.sceneTarget)
  }

  /** Unmediated. Only the limiter itself may reach the canvas. */
  private rawBlit(material: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quadMesh.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.quadScene, this.quadCamera)
    this.renderer.setRenderTarget(null)
  }

  /** The buffer modes draw into. Modes that render their own scene need this. */
  get outputTarget(): THREE.WebGLRenderTarget {
    return this.limiter.sceneTarget
  }

  /** Run the luminance clamp and put the frame on the canvas. Call once per frame. */
  present(dt: number): void {
    this.limiter.present(dt, this.reducedMotion)
  }

  /** Debug only — costs a pipeline stall. */
  sampleLuminance() {
    return this.limiter.sample()
  }

  /** Drop the accumulated luminance state, e.g. across a mode switch. */
  resetLimiter(): void {
    this.limiter.reset()
  }

  /** Clear the scene buffer to a colour. */
  clear(color: THREE.ColorRepresentation, alpha = 1): void {
    this.renderer.setClearColor(color, alpha)
    this.renderer.setRenderTarget(this.limiter.sceneTarget)
    this.renderer.clear(true, true, false)
    this.renderer.setRenderTarget(null)
  }

  dispose(): void {
    this.limiter.dispose()
    for (const pair of [...this.pingPongs]) pair.dispose()
    this.quadGeometry.dispose()
    this.placeholder.dispose()
    this.quadScene.clear()
    this.renderer.dispose()
  }
}
