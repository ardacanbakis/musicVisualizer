/**
 * Full-frame luminance rate limiter — the anti-strobe requirement.
 *
 * This lives in the stage rather than in each mode, and it is not a setting.
 * A mode cannot opt out of it, cannot forget it, and does not have to know it
 * exists: modes render into `sceneTarget` and this decides what actually
 * reaches the glass. That placement is the entire point — "every mode must
 * remember to not strobe" is a rule that gets broken by mode number nine.
 *
 * How it works, all on the GPU:
 *
 *   1. The scene is reduced to a single texel of mean linear luminance through
 *      a chain of halving passes.
 *   2. A 1x1 ping-pong holds the *allowed* luminance, which may rise by at
 *      most `maxRise` per second but may fall freely.
 *   3. The present pass scales the scene by allowed/current and encodes sRGB.
 *
 * No CPU readback in the normal path. A 1x1 readPixels is a full pipeline
 * stall, and paying that every frame to avoid a flash nobody has produced yet
 * is the wrong trade — the debug overlay can ask for it explicitly.
 *
 * Why only the rise is clamped: the hazard is the flash *to* bright, and
 * limiting the fall would mean amplifying a dark frame to hold luminance up,
 * which lifts sensor noise and banding into view. Darkening freely is both
 * safe and cheap.
 */
import * as THREE from 'three'
import { COLOR_HELPERS, FULLSCREEN_VERTEX } from './glsl'

/**
 * Luminance units per second the frame may brighten by.
 *
 * At 1.2, a full black-to-white swing takes ~0.83 s, so full-amplitude
 * alternation cannot exceed ~0.6 Hz — comfortably under the ~3 Hz where
 * photosensitivity guidance starts to care.
 */
const MAX_RISE = 1.2
/** Reduced motion wants a genuinely calmer variant, not a token adjustment. */
const MAX_RISE_REDUCED = 0.45

/** First reduction target. Big enough to be a fair sample of the frame. */
const CHAIN_START = 64

export class LuminanceLimiter {
  private scene: THREE.WebGLRenderTarget
  /** 64, 32, 16, 8, 4, 2, 1 */
  private chain: THREE.WebGLRenderTarget[] = []
  private stateA: THREE.WebGLRenderTarget
  private stateB: THREE.WebGLRenderTarget
  private stateFlipped = false

  private reduceFirst: THREE.ShaderMaterial
  private reduceStep: THREE.ShaderMaterial
  private stateUpdate: THREE.ShaderMaterial
  private presentMaterial: THREE.ShaderMaterial
  private readbackBuffer = new Float32Array(4)
  private primed = false

  constructor(
    private renderer: THREE.WebGLRenderer,
    private blit: (material: THREE.Material, target: THREE.WebGLRenderTarget | null) => void,
    width: number,
    height: number,
  ) {
    this.scene = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Depth is on because modes that render real geometry (3D terrain) draw
      // into this target and need depth testing. Full-screen-quad modes simply
      // never use it; the cost is one depth attachment for the whole app.
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    })

    const tiny = (size: number) =>
      new THREE.WebGLRenderTarget(size, size, {
        // Float rather than half float so the debug readback can use gl.FLOAT,
        // which is the widely supported readPixels path.
        type: THREE.FloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      })

    for (let size = CHAIN_START; size >= 1; size = Math.floor(size / 2)) {
      this.chain.push(tiny(size))
    }
    this.stateA = tiny(1)
    this.stateB = tiny(1)

    this.reduceFirst = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      depthTest: false,
      depthWrite: false,
      uniforms: { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */ `
        precision highp float;
        ${COLOR_HELPERS}
        uniform sampler2D uSource;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          // 4x4 taps across this output cell. Not a true box filter over every
          // source pixel, but a stable estimate of the mean — and stability is
          // what matters, since a jittery measurement would itself modulate
          // the gain and produce the flicker this exists to prevent.
          float total = 0.0;
          for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 4; x++) {
              vec2 offset = (vec2(float(x), float(y)) + 0.5) / 4.0 - 0.5;
              total += ambLuminance(texture2D(uSource, vUv + offset * uTexel).rgb);
            }
          }
          gl_FragColor = vec4(total / 16.0, 0.0, 0.0, 1.0);
        }
      `,
    })

    this.reduceStep = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      depthTest: false,
      depthWrite: false,
      uniforms: { uSource: { value: null }, uTexel: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uSource;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          float a = texture2D(uSource, vUv + vec2(-0.25, -0.25) * uTexel).r;
          float b = texture2D(uSource, vUv + vec2( 0.25, -0.25) * uTexel).r;
          float c = texture2D(uSource, vUv + vec2(-0.25,  0.25) * uTexel).r;
          float d = texture2D(uSource, vUv + vec2( 0.25,  0.25) * uTexel).r;
          gl_FragColor = vec4((a + b + c + d) * 0.25, 0.0, 0.0, 1.0);
        }
      `,
    })

    this.stateUpdate = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCurrent: { value: null },
        uPrevious: { value: null },
        uMaxRise: { value: MAX_RISE },
        uDt: { value: 1 / 60 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uCurrent;
        uniform sampler2D uPrevious;
        uniform float uMaxRise;
        uniform float uDt;
        void main() {
          float current = texture2D(uCurrent, vec2(0.5)).r;
          float previous = texture2D(uPrevious, vec2(0.5)).r;
          // Rise is capped; fall is free. One min() does both.
          float allowed = min(current, previous + uMaxRise * uDt);
          gl_FragColor = vec4(allowed, 0.0, 0.0, 1.0);
        }
      `,
    })

    this.presentMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uScene: { value: this.scene.texture },
        uCurrent: { value: null },
        uAllowed: { value: null },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        ${COLOR_HELPERS}
        uniform sampler2D uScene;
        uniform sampler2D uCurrent;
        uniform sampler2D uAllowed;
        varying vec2 vUv;
        void main() {
          float current = texture2D(uCurrent, vec2(0.5)).r;
          float allowed = texture2D(uAllowed, vec2(0.5)).r;
          // Guard the divide: a genuinely black frame needs no attenuation,
          // and 0/0 would put NaN on the screen.
          float gain = current > 1e-5 ? min(1.0, allowed / current) : 1.0;
          vec3 color = texture2D(uScene, vUv).rgb * gain;
          gl_FragColor = vec4(ambLinearToSrgb(color), 1.0);
        }
      `,
    })
  }

  /** The target modes render into. */
  get sceneTarget(): THREE.WebGLRenderTarget {
    return this.scene
  }

  private get stateRead(): THREE.WebGLRenderTarget {
    return this.stateFlipped ? this.stateB : this.stateA
  }

  private get stateWrite(): THREE.WebGLRenderTarget {
    return this.stateFlipped ? this.stateA : this.stateB
  }

  setSize(width: number, height: number): void {
    this.scene.setSize(width, height)
  }

  /**
   * Measure, clamp, and draw the scene to the canvas.
   * @param dt seconds since the previous frame, already clamped by the bus.
   */
  present(dt: number, reducedMotion: boolean): void {
    // --- reduce to 1x1 ---
    const first = this.chain[0]
    this.reduceFirst.uniforms.uSource.value = this.scene.texture
    ;(this.reduceFirst.uniforms.uTexel.value as THREE.Vector2).set(
      1 / this.scene.width,
      1 / this.scene.height,
    )
    this.blit(this.reduceFirst, first)

    for (let i = 1; i < this.chain.length; i++) {
      const source = this.chain[i - 1]
      this.reduceStep.uniforms.uSource.value = source.texture
      ;(this.reduceStep.uniforms.uTexel.value as THREE.Vector2).set(
        1 / source.width,
        1 / source.height,
      )
      this.blit(this.reduceStep, this.chain[i])
    }

    const measured = this.chain[this.chain.length - 1]

    // On the very first frame the state buffer is uninitialised, so seed it
    // from the measurement. Without this the screen fades up from black on
    // every mode switch, which reads as a flaw rather than a transition.
    if (!this.primed) {
      this.primed = true
      this.stateUpdate.uniforms.uCurrent.value = measured.texture
      this.stateUpdate.uniforms.uPrevious.value = measured.texture
      this.stateUpdate.uniforms.uMaxRise.value = 1e9
      this.stateUpdate.uniforms.uDt.value = 1
      this.blit(this.stateUpdate, this.stateWrite)
      this.stateFlipped = !this.stateFlipped
    }

    // --- advance the allowed luminance ---
    this.stateUpdate.uniforms.uCurrent.value = measured.texture
    this.stateUpdate.uniforms.uPrevious.value = this.stateRead.texture
    this.stateUpdate.uniforms.uMaxRise.value = reducedMotion ? MAX_RISE_REDUCED : MAX_RISE
    this.stateUpdate.uniforms.uDt.value = dt
    this.blit(this.stateUpdate, this.stateWrite)
    this.stateFlipped = !this.stateFlipped

    // --- draw to the canvas ---
    this.presentMaterial.uniforms.uScene.value = this.scene.texture
    this.presentMaterial.uniforms.uCurrent.value = measured.texture
    this.presentMaterial.uniforms.uAllowed.value = this.stateRead.texture
    this.blit(this.presentMaterial, null)
  }

  /**
   * Debug only: pull the measured and allowed luminance back to the CPU.
   * Costs a pipeline stall, so the overlay calls it and nothing else does.
   */
  sample(): { measured: number; allowed: number; gain: number } | null {
    try {
      const measured = this.chain[this.chain.length - 1]
      this.renderer.readRenderTargetPixels(measured, 0, 0, 1, 1, this.readbackBuffer)
      const current = this.readbackBuffer[0]
      this.renderer.readRenderTargetPixels(this.stateRead, 0, 0, 1, 1, this.readbackBuffer)
      const allowed = this.readbackBuffer[0]
      return {
        measured: current,
        allowed,
        gain: current > 1e-5 ? Math.min(1, allowed / current) : 1,
      }
    } catch {
      // Float readback is not universally supported and this is diagnostics.
      return null
    }
  }

  /** Forget the accumulated state, e.g. on a mode switch. */
  reset(): void {
    this.primed = false
  }

  dispose(): void {
    this.scene.dispose()
    for (const target of this.chain) target.dispose()
    this.stateA.dispose()
    this.stateB.dispose()
    this.reduceFirst.dispose()
    this.reduceStep.dispose()
    this.stateUpdate.dispose()
    this.presentMaterial.dispose()
  }
}
