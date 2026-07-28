/**
 * Fullscreen, tracked as state rather than assumed.
 *
 * The button cannot just toggle a boolean it owns: the user can leave
 * fullscreen with Escape or F11 without going anywhere near it, and a browser
 * can refuse the request outright. The only source of truth is
 * `document.fullscreenElement`, so that is what this listens to.
 */
import { useCallback, useEffect, useState } from 'react'

export function useFullscreen(): {
  isFullscreen: boolean
  supported: boolean
  toggle: () => void
} {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggle = useCallback(() => {
    // requestFullscreen rejects when not driven by a user gesture, and on iOS
    // Safari it may not exist at all. Either way this must not throw into the
    // render loop.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {})
    }
  }, [])

  const supported =
    typeof document !== 'undefined' && Boolean(document.documentElement.requestFullscreen)

  return { isFullscreen, supported, toggle }
}
