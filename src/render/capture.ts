
/**
 * Still export.
 *
 * The awkward part is not encoding a PNG, it is that several modes keep their
 * picture in a feedback buffer — flow-field trails, reaction-diffusion, the
 * heat field. Resizing the drawing buffer throws that state away, so naively
 * rendering one frame at 4x gives you a picture of a reaction-diffusion that
 * started a sixtieth of a second ago: a seeded grid, not the pattern you were
 * looking at.
 *
 * So a high-resolution capture resizes, then lets the *normal* render loop run
 * for a while at the new size before grabbing the frame. Real time passes, so
 * feedback buffers re-accumulate exactly as they did originally and trails and
 * patterns look right. It costs a second or two, which for an export nobody
 * minds.
 *
 * A 1x capture skips all of that: the drawing buffer already holds the frame
 * on screen, so it is grabbed directly and is exact.
 */

/** Frames rendered at the target size before grabbing, so feedback settles. */
export const SETTLE_FRAMES = 110

/**
 * Hard ceiling on the settle, in milliseconds.
 *
 * The frame count assumes something near 60 Hz. A 4x export on a weak GPU can
 * drop to a few frames a second, and then 110 frames is most of a minute of a
 * frozen-looking UI. Measured at 2x under a software rasteriser: 42 seconds.
 * Capping by wall clock means a slow machine gets a slightly less settled
 * picture instead of an app that appears to have hung.
 */
export const SETTLE_MAX_MS = 5000

export interface CaptureRequest {
  scale: number
  /** Frames still to render before the grab. */
  remaining: number
  started: boolean
  /** `performance.now()` past which the grab happens regardless of `remaining`. */
  deadline: number
  resolve: (blob: Blob | null) => void
}

/**
 * Largest scale the GPU will actually allow, given the current buffer size.
 *
 * Asking for 4x of a 4K panel is 15360 px, past `MAX_TEXTURE_SIZE` on most
 * hardware. Exceeding it does not throw — it produces incomplete framebuffers
 * and a black or truncated image — so it has to be clamped up front.
 */
export function clampCaptureScale(
  requested: number,
  width: number,
  height: number,
  maxTextureSize: number,
): number {
  if (!Number.isFinite(requested) || requested <= 1) return 1
  const longest = Math.max(width, height, 1)
  // Leave a little headroom: the limiter allocates its own targets alongside
  // the scene buffer, and drivers get unhappy right at the limit.
  const budget = (maxTextureSize * 0.95) / longest
  const allowed = Math.max(1, Math.floor(budget * 4) / 4)
  return Math.min(requested, allowed)
}

/** `visualiser-<mode>-<timestamp>.png` */
export function captureFilename(modeId: string, scale: number): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  const suffix = scale > 1 ? `@${scale}x` : ''
  return `visualiser-${modeId}-${stamp}${suffix}.png`
}

/** Hand a blob to the browser as a download, then release the object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking immediately can cancel the download in some browsers; a tick is
  // enough for the navigation to have been queued.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
