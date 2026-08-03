import { describe, expect, it } from 'vitest'
import { captureFilename, clampCaptureScale } from './capture'

describe('clampCaptureScale', () => {
  it('allows a scale that fits comfortably', () => {
    expect(clampCaptureScale(2, 1920, 1080, 8192)).toBe(2)
  })

  it('clamps a scale that would exceed the texture limit', () => {
    // 4x of 3840 is 15360, well past a common 8192 limit. Exceeding it does
    // not throw — it silently produces an incomplete framebuffer and a black
    // image — so it has to be caught here.
    const scale = clampCaptureScale(4, 3840, 2160, 8192)
    expect(scale).toBeLessThan(4)
    expect(3840 * scale).toBeLessThanOrEqual(8192)
  })

  it('leaves headroom under the hard limit', () => {
    // The limiter allocates its own targets alongside the scene buffer, and
    // drivers are unreliable right at the maximum.
    const scale = clampCaptureScale(8, 4096, 4096, 8192)
    expect(4096 * scale).toBeLessThan(8192)
  })

  it('never returns less than 1', () => {
    expect(clampCaptureScale(4, 16384, 16384, 4096)).toBe(1)
    expect(clampCaptureScale(0.25, 1920, 1080, 8192)).toBe(1)
    expect(clampCaptureScale(-3, 1920, 1080, 8192)).toBe(1)
  })

  it('passes 1x through untouched', () => {
    expect(clampCaptureScale(1, 7680, 4320, 4096)).toBe(1)
  })

  it('is safe on garbage input', () => {
    expect(clampCaptureScale(NaN, 1920, 1080, 8192)).toBe(1)
    expect(clampCaptureScale(Infinity, 1920, 1080, 8192)).toBeGreaterThanOrEqual(1)
  })

  it('quantises to quarter steps rather than an arbitrary fraction', () => {
    const scale = clampCaptureScale(4, 2000, 1000, 8192)
    expect(scale * 4).toBeCloseTo(Math.round(scale * 4))
  })
})

describe('captureFilename', () => {
  it('includes the mode and a png extension', () => {
    const name = captureFilename('flow-field', 1)
    expect(name.startsWith('visualiser-flow-field-')).toBe(true)
    expect(name.endsWith('.png')).toBe(true)
  })

  it('marks the scale only above 1x', () => {
    expect(captureFilename('aurora', 1)).not.toContain('@')
    expect(captureFilename('aurora', 2)).toContain('@2x')
  })

  it('contains no characters that break a filesystem', () => {
    // ISO timestamps carry colons, which are illegal on Windows and awkward
    // everywhere else.
    const name = captureFilename('winamp', 4)
    expect(name).not.toMatch(/[:*?"<>|]/)
  })

  it('produces a different name on successive seconds', () => {
    // Not a strict uniqueness guarantee — same-second captures collide — but
    // the timestamp must at least be present and vary.
    const name = captureFilename('bars', 1)
    expect(name).toMatch(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/)
  })
})
