/**
 * k-means in a worker.
 *
 * Clustering 4096 samples over 12 iterations is tens of milliseconds — not
 * catastrophic, but it lands on the main thread exactly when a track changes,
 * which is the moment the palette crossfade starts. A stutter there is the
 * most visible place it could possibly be.
 *
 * The module itself holds no state; all the logic is in kmeans.ts so it stays
 * testable without spinning up a worker.
 */
import { kmeans } from './kmeans'
import type { Cluster } from './kmeans'

export interface KMeansRequest {
  id: number
  pixels: ArrayBuffer
  k?: number
  seed?: number
}

export interface KMeansResponse {
  id: number
  clusters: Cluster[]
}

self.onmessage = (event: MessageEvent<KMeansRequest>) => {
  const { id, pixels, k, seed } = event.data
  const clusters = kmeans(new Uint8Array(pixels), { k, seed })
  const response: KMeansResponse = { id, clusters }
  ;(self as unknown as Worker).postMessage(response)
}
