/**
 * Album art -> Palette.
 *
 * Load the image, downsample it, cluster it in a worker, and hand the result
 * to the same `buildPalette` the built-in palettes use — so a Spotify-derived
 * palette and a hand-written one are structurally identical and no mode can
 * tell them apart. That is the whole reason `buildPalette` takes weights.
 *
 * Every failure path returns null and the caller keeps the current palette.
 * There are several: the image may not load, the CDN may not send permissive
 * CORS headers even with crossOrigin set, and the canvas may still end up
 * tainted — in which case `getImageData` throws a SecurityError. All of those
 * are ordinary, and none of them may surface as an error on a wall display.
 */
import { buildPalette } from '../signal/color'
import type { Palette, RGB } from '../signal/types'
import type { Cluster } from './kmeans'
import type { KMeansRequest, KMeansResponse } from './kmeans.worker'

/**
 * Album art is 640x640; clustering every pixel is 400k samples for a result
 * indistinguishable from 64x64. The downsample is most of the speed.
 */
const SAMPLE_SIZE = 64

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, (clusters: Cluster[]) => void>()

function ensureWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./kmeans.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<KMeansResponse>) => {
      const resolve = pending.get(event.data.id)
      if (resolve) {
        pending.delete(event.data.id)
        resolve(event.data.clusters)
      }
    }
    worker.onerror = () => {
      // A dead worker must not leave callers hanging forever.
      for (const resolve of pending.values()) resolve([])
      pending.clear()
    }
    return worker
  } catch {
    return null
  }
}

function clusterInWorker(pixels: Uint8ClampedArray, seed: number): Promise<Cluster[]> {
  const instance = ensureWorker()
  if (!instance) return Promise.resolve([])

  const id = nextRequestId++
  // Copy into a plain ArrayBuffer so it can be transferred rather than
  // structured-cloned; the underlying ImageData buffer is not transferable.
  const copy = new Uint8Array(pixels).buffer
  const request: KMeansRequest = { id, pixels: copy, k: 8, seed }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      resolve([])
    }, 5000)
    pending.set(id, (clusters) => {
      clearTimeout(timeout)
      resolve(clusters)
    })
    instance.postMessage(request, [copy])
  })
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    // Required for the canvas to stay untainted. Must be set before src.
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

/** Downsample to a small canvas and read the pixels back, or null if tainted. */
function samplePixels(image: HTMLImageElement): Uint8ClampedArray | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_SIZE
    canvas.height = SAMPLE_SIZE
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
    return context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data
  } catch {
    // SecurityError: the CDN did not send CORS headers, so the canvas is
    // tainted despite crossOrigin. Caller falls back to the built-in palette.
    return null
  }
}

/**
 * Build a Palette from album art.
 *
 * @param trackId used as the clustering seed, so the same track always yields
 *                the same palette — including across reloads.
 */
export type ExtractionFailure =
  | 'image-failed'
  | 'canvas-tainted'
  | 'too-few-colours'
  | 'build-failed'

export interface ExtractionResult {
  palette: Palette | null
  /** Why it failed, for the settings panel. Null on success. */
  failure: ExtractionFailure | null
}

export async function paletteFromArtwork(
  url: string,
  trackId: string,
): Promise<ExtractionResult> {
  // Every failure below is ordinary and none of them may reach the canvas —
  // but returning a bare null made them indistinguishable from each other and
  // from "no artwork", which left the whole feature looking like it simply
  // did nothing. The reason is reported in the settings panel.
  const image = await loadImage(url)
  if (!image) return { palette: null, failure: 'image-failed' }

  const pixels = samplePixels(image)
  if (!pixels) return { palette: null, failure: 'canvas-tainted' }

  const clusters = await clusterInWorker(pixels, hashSeed(trackId))
  if (clusters.length < 2) return { palette: null, failure: 'too-few-colours' }

  const colors: RGB[] = clusters.map((c) => c.color)
  const weights = clusters.map((c) => c.weight)

  try {
    return {
      palette: buildPalette(`spotify:${trackId}`, 'Album', colors, weights),
      failure: null,
    }
  } catch {
    return { palette: null, failure: 'build-failed' }
  }
}

/** Stable numeric seed from a track id. */
function hashSeed(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function disposeWorker(): void {
  worker?.terminate()
  worker = null
  pending.clear()
}
