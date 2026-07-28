/**
 * 3D terrain — a displaced plane under a slowly orbiting camera.
 *
 * The only mode so far with an actual 3D scene rather than a full-screen quad,
 * so it renders its own scene through `ctx.renderer` into the stage's output
 * target. Everything downstream — the luminance clamp, the sRGB encode — is
 * unchanged, because it writes linear values into the same buffer every other
 * mode writes into.
 *
 * The heightfield is the interesting part. Driving it purely from the band
 * array gives ridges that jump around every frame, because band 12 has no
 * spatial relationship to band 13's neighbourhood on the mesh. Instead the
 * terrain has a permanent noise-based base, and the bands *modulate ridge
 * amplitude by distance from the centre*: low frequencies raise the ground
 * near the middle, high frequencies raise the far edges. The result reads as
 * a landscape that breathes with the music rather than a bar chart in
 * perspective.
 *
 * Displacement happens in the vertex shader, so the CPU never touches vertex
 * data — a 256x256 grid is 65k vertices and rewriting those each frame would
 * dominate the frame time.
 */
import * as THREE from 'three'
import { BAND_COUNT } from '../../signal/types'
import type { Signal } from '../../signal/types'
import { COLOR_HELPERS, SIMPLEX_NOISE } from '../glsl'
import { BandTexture, PaletteTexture } from '../paletteTexture'
import type { ParamSchema, ParamValues, RenderContext, VisualMode } from '../types'

const GRID = 256
const PLANE_SIZE = 60

const VERTEX = /* glsl */ `
  precision highp float;

  ${SIMPLEX_NOISE}

  uniform sampler2D uBands;
  uniform float uTime;
  uniform float uRelief;
  uniform float uBandGain;
  uniform float uRoughness;

  varying float vHeight;
  varying vec2 vGrid;
  varying vec3 vWorld;

  float terrainHeight(vec2 p) {
    // Fractal base: three octaves is enough to read as landscape and cheap
    // enough to evaluate twice more for the normal.
    float h = 0.0;
    h += snoise(vec3(p * 0.05, uTime * 0.02)) * 1.0;
    h += snoise(vec3(p * 0.12, uTime * 0.03)) * 0.45;
    h += snoise(vec3(p * 0.27, uTime * 0.05)) * 0.2;
    h *= uRoughness;

    // Radial band mapping: distance from the centre selects the band, so bass
    // lifts the middle and treble lifts the horizon. Spatially coherent, which
    // band-index-to-vertex mapping is not.
    float radius = length(p) / ${(PLANE_SIZE / 2).toFixed(1)};
    float band = texture2D(uBands, vec2(clamp(radius, 0.0, 1.0), 0.5)).r;

    // Ridged noise for the audio-driven component. The abs() fold gives sharp
    // crests rather than rolling hills, which is what makes the response to
    // the music legible at a glance.
    float ridge = 1.0 - abs(snoise(vec3(p * 0.16, uTime * 0.08)));
    ridge = ridge * ridge;

    h += ridge * band * uBandGain;
    return h * uRelief;
  }

  void main() {
    vec3 pos = position;
    float h = terrainHeight(pos.xy);
    pos.z = h;

    vHeight = h;
    vGrid = pos.xy;
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorld = world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const FRAGMENT = /* glsl */ `
  precision highp float;

  ${COLOR_HELPERS}

  uniform sampler2D uPalette;
  uniform vec3 uBackground;
  uniform float uRelief;
  uniform float uFog;
  uniform float uGlow;

  varying float vHeight;
  varying vec2 vGrid;
  varying vec3 vWorld;

  void main() {
    // Screen-space derivatives for the normal. Far cheaper than sampling the
    // height function three more times per fragment, and the mesh is dense
    // enough that the faceting this produces is invisible.
    vec3 dx = dFdx(vWorld);
    vec3 dy = dFdy(vWorld);
    vec3 normal = normalize(cross(dx, dy));

    vec3 lightDir = normalize(vec3(0.4, 0.7, 0.6));
    float diffuse = max(dot(normal, lightDir), 0.0);
    // Wrapped ambient rather than a constant: keeps the unlit faces readable
    // without flattening the whole surface.
    float ambient = 0.16 + 0.28 * (dot(normal, vec3(0.0, 0.0, 1.0)) * 0.5 + 0.5);

    float t = clamp(vHeight / max(uRelief, 0.001) * 0.5 + 0.5, 0.0, 1.0);
    vec3 ink = ambSrgbToLinear(texture2D(uPalette, vec2(t, 0.5)).rgb);

    vec3 color = ink * (ambient + diffuse * 0.7);

    // Crests catch a highlight, which is what sells the ridges as sharp.
    color += ink * uGlow * smoothstep(0.55, 1.0, t) * 0.6;

    // Distance fog into the background colour, so the terrain dissolves at the
    // horizon instead of ending on a hard cut against the sky.
    float depth = length(vWorld - cameraPosition);
    float fog = 1.0 - exp(-depth * depth * uFog * 0.00016);
    color = mix(color, uBackground, clamp(fog, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
  }
`

export const terrainParams = {
  relief: {
    type: 'float',
    label: 'Relief',
    hint: 'Overall vertical scale of the landscape.',
    default: 3,
    min: 0.5,
    max: 10,
    step: 0.1,
  },
  bandGain: {
    type: 'float',
    label: 'Spectrum ridges',
    hint: 'How much the band array raises ridges.',
    default: 2.2,
    min: 0,
    max: 6,
    step: 0.05,
  },
  roughness: {
    type: 'float',
    label: 'Roughness',
    default: 1,
    min: 0.2,
    max: 2.5,
    step: 0.01,
  },
  orbit: {
    type: 'float',
    label: 'Camera drift',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  altitude: {
    type: 'float',
    label: 'Camera height',
    default: 1,
    min: 0.3,
    max: 2.5,
    step: 0.01,
  },
  fog: {
    type: 'float',
    label: 'Fog',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
  },
  glow: {
    type: 'float',
    label: 'Crest highlight',
    default: 0.6,
    min: 0,
    max: 2,
    step: 0.01,
  },
} satisfies ParamSchema

class TerrainMode implements VisualMode {
  readonly id = 'terrain'
  readonly name = '3D Terrain'
  readonly description =
    'A displaced landscape under a slow orbital camera. Low frequencies raise the ground near you, high frequencies the horizon.'
  readonly params: ParamSchema = terrainParams

  private ctx: RenderContext | null = null
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(55, 1, 0.5, 300)
  private geometry: THREE.PlaneGeometry | null = null
  private material: THREE.ShaderMaterial | null = null
  private mesh: THREE.Mesh | null = null
  private palette = new PaletteTexture()
  private bands = new BandTexture(BAND_COUNT)
  private orbitAngle = 0

  init(ctx: RenderContext): void {
    this.ctx = ctx

    this.geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, GRID, GRID)

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uBands: { value: this.bands.texture },
        uPalette: { value: this.palette.texture },
        uBackground: { value: new THREE.Color(0, 0, 0) },
        uTime: { value: 0 },
        uRelief: { value: 3 },
        uBandGain: { value: 2.2 },
        uRoughness: { value: 1 },
        uFog: { value: 1 },
        uGlow: { value: 0.6 },
      },
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    // The plane is built in XY with displacement along Z, so it needs no
    // rotation — the camera is placed to look along Z instead.
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  frame(signal: Signal, params: ParamValues): void {
    const ctx = this.ctx
    const material = this.material
    if (!ctx || !material) return

    this.bands.update(signal.bands)
    this.palette.update(signal.palette)

    const calm = ctx.reducedMotion
    this.orbitAngle += signal.dt * (params.orbit as number) * 0.035 * (calm ? 0.35 : 1)

    const relief = params.relief as number
    const u = material.uniforms
    u.uTime.value = signal.t * (calm ? 0.4 : 1)
    u.uRelief.value = relief
    u.uBandGain.value = params.bandGain as number
    u.uRoughness.value = params.roughness as number
    u.uFog.value = params.fog as number
    u.uGlow.value = params.glow as number

    const background = signal.palette.background
    ;(u.uBackground.value as THREE.Color).setRGB(
      background[0],
      background[1],
      background[2],
      THREE.SRGBColorSpace,
    )

    // Orbit at a low altitude so the ridges are seen edge-on. A top-down view
    // turns the whole thing into a texture and loses the terrain entirely.
    const radius = 26
    const height = 6 * (params.altitude as number) + relief
    this.camera.position.set(
      Math.cos(this.orbitAngle) * radius,
      Math.sin(this.orbitAngle) * radius,
      height,
    )
    this.camera.up.set(0, 0, 1)
    this.camera.lookAt(0, 0, relief * 0.2)
    this.camera.aspect = ctx.width / Math.max(1, ctx.height)
    this.camera.updateProjectionMatrix()

    const target = ctx.outputTarget
    ctx.renderer.setRenderTarget(target)
    // This mode fills the frame with geometry rather than a quad, so it owns
    // clearing the buffer — otherwise the previous frame shows through the sky.
    ctx.renderer.setClearColor(u.uBackground.value as THREE.Color, 1)
    ctx.renderer.clear(true, true, false)
    ctx.renderer.render(this.scene, this.camera)
    ctx.renderer.setRenderTarget(null)
  }

  resize(): void {
    // Aspect is set from the context each frame.
  }

  dispose(): void {
    if (this.mesh) this.scene.remove(this.mesh)
    this.geometry?.dispose()
    this.material?.dispose()
    this.palette.dispose()
    this.bands.dispose()
    this.scene.clear()
    this.geometry = null
    this.material = null
    this.mesh = null
    this.ctx = null
  }
}

export function createTerrainMode(): VisualMode {
  return new TerrainMode()
}
