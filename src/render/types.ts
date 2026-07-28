/**
 * PUBLIC API — the visual mode contract.
 *
 * Adding visual mode number twelve must mean writing one file and adding one
 * import to the registry. Nothing else. See CLAUDE.md.
 *
 * Rules:
 *  - No mode may import from another mode.
 *  - `params` is declarative; the settings panel is generated from it. Do not
 *    hand-write a control panel for a mode.
 *  - `dispose()` must free every GPU resource the mode allocated. This app runs
 *    for 8+ hours and rotates modes; a leak here is a crash by morning.
 */
import type * as THREE from 'three'
import type { Signal } from '../signal/types'

// ---------------------------------------------------------------------------
// Declarative parameter schema
// ---------------------------------------------------------------------------

interface ParamBase {
  label: string
  /** Shown as help text under the control. */
  hint?: string
  /** Optional grouping in the generated settings panel. */
  group?: string
}

export interface FloatParam extends ParamBase {
  type: 'float'
  default: number
  min: number
  max: number
  step?: number
}

export interface IntParam extends ParamBase {
  type: 'int'
  default: number
  min: number
  max: number
  step?: number
}

export interface BoolParam extends ParamBase {
  type: 'bool'
  default: boolean
}

export interface EnumParam extends ParamBase {
  type: 'enum'
  default: string
  options: { value: string; label: string }[]
}

export interface ColorParam extends ParamBase {
  type: 'color'
  /** '#rrggbb' */
  default: string
}

export type ParamDef = FloatParam | IntParam | BoolParam | EnumParam | ColorParam

/** Declarative list of typed controls, keyed by param name. */
export type ParamSchema = Record<string, ParamDef>

export type ParamValue = number | boolean | string
export type ParamValues = Record<string, ParamValue>

/** Pull the defaults out of a schema. Used on first run and on "reset". */
export function defaultParams(schema: ParamSchema): ParamValues {
  const out: ParamValues = {}
  for (const key of Object.keys(schema)) out[key] = schema[key].default
  return out
}

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

/** A pair of render targets for feedback effects (trails, reaction-diffusion). */
export interface PingPong {
  /** The target holding last frame's result. Bind as a texture input. */
  readonly read: THREE.WebGLRenderTarget
  /** The target to render this frame into. */
  readonly write: THREE.WebGLRenderTarget
  /** Call after rendering into `write`. */
  swap(): void
  /** Resize both targets. Contents are lost. */
  setSize(width: number, height: number): void
  /** Clear both targets to the given colour/alpha. */
  clear(r?: number, g?: number, b?: number, a?: number): void
  dispose(): void
}

export interface PingPongOptions {
  /** Defaults to the canvas size. */
  width?: number
  height?: number
  /** Defaults to HalfFloatType — enough range for feedback without the cost. */
  type?: THREE.TextureDataType
  /** Defaults to THREE.LinearFilter. */
  filter?: THREE.MagnificationTextureFilter
  /** Defaults to THREE.ClampToEdgeWrapping. */
  wrap?: THREE.Wrapping
}

export interface RenderContext {
  /** Shared across all modes. Never dispose this from inside a mode. */
  readonly renderer: THREE.WebGLRenderer
  /** Drawing-buffer size in device pixels (CSS size * dpr). */
  readonly width: number
  readonly height: number
  /** Device pixel ratio, already capped at 2. */
  readonly dpr: number
  /**
   * The user has asked for reduced motion. Modes MUST honour this with a
   * genuinely calmer variant — slower drift, fewer respawns, longer trails —
   * not merely a slightly lower speed. The stage already tightens the
   * luminance limiter on top of whatever the mode does.
   */
  readonly reducedMotion: boolean
  /** Allocate a feedback buffer pair. The mode owns it and must dispose it. */
  createPingPong(options?: PingPongOptions): PingPong
  /**
   * Draw a full-screen quad with `material` into `target` (null = the canvas).
   * The quad's geometry and camera are shared, so this costs nothing per mode.
   */
  blit(material: THREE.Material, target?: THREE.WebGLRenderTarget | null): void
}

// ---------------------------------------------------------------------------
// The mode itself
// ---------------------------------------------------------------------------

export interface VisualMode {
  /** Stable identifier, persisted to localStorage. Never change it once shipped. */
  id: string
  name: string
  description: string
  params: ParamSchema
  init(ctx: RenderContext): void
  frame(signal: Signal, params: ParamValues): void
  resize(width: number, height: number, dpr: number): void
  /** MUST free every GPU resource this mode allocated. */
  dispose(): void
  /** Optional high-resolution still export. `scale` multiplies the canvas size. */
  capture?(scale: number): Promise<Blob>
}

/** What a mode module exports. Registered centrally; modes never import each other. */
export type VisualModeFactory = () => VisualMode
