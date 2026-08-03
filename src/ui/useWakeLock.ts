/**
 * Screen Wake Lock, so the display does not sleep mid-session.
 *
 * The lock is *automatically released* whenever the document becomes hidden —
 * switching tabs, locking the machine, minimising. It is not re-acquired for
 * you, so a naive one-shot request works until the first time the user looks
 * at something else, and then the screen quietly starts sleeping again with no
 * error anywhere. Re-acquiring on visibilitychange is the whole job.
 *
 * Unsupported browsers, and requests refused because the document is not
 * visible or not user-activated, are ordinary. Everything fails silently: a
 * wall display must never show a dialog about a power setting.
 */
import { useEffect, useState } from 'react'

interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

export function useWakeLock(enabled: boolean): { active: boolean; supported: boolean } {
  const [active, setActive] = useState(false)
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator

  useEffect(() => {
    if (!enabled || !supported) {
      setActive(false)
      return
    }

    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.hidden || sentinel) return
      try {
        const lock = await (
          navigator as unknown as {
            wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
          }
        ).wakeLock.request('screen')
        if (cancelled) {
          void lock.release().catch(() => {})
          return
        }
        sentinel = lock
        setActive(true)
        // The browser can drop the lock on its own; reflect that rather than
        // reporting active forever.
        lock.addEventListener('release', () => {
          sentinel = null
          setActive(false)
        })
      } catch {
        setActive(false)
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        // Already released by the browser; just forget our handle.
        sentinel = null
        setActive(false)
      } else {
        void acquire()
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {})
      sentinel = null
    }
  }, [enabled, supported])

  return { active, supported }
}
