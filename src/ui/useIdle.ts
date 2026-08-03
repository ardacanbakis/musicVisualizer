/**
 * Idle detection for auto-hiding the chrome.
 *
 * The primary use is a screen running unattended for hours, so the controls
 * should get out of the way on their own and come straight back the moment
 * anyone reaches for the mouse.
 *
 * Two details that matter more than they look:
 *
 * - **Hovering the panel counts as activity.** Reading a slider's value
 *   without moving the mouse for three seconds must not make the panel
 *   vanish out from under the pointer. The hook takes a "held" flag for that.
 * - **Wake events are passive and coarse.** Any pointer movement, key, touch,
 *   scroll or click resets the timer. Listening only to mousemove misses a
 *   user driving entirely by keyboard shortcuts, who would watch the chrome
 *   disappear while they were actively using it.
 */
import { useEffect, useRef, useState } from 'react'

const WAKE_EVENTS = [
  'mousemove',
  'mousedown',
  'wheel',
  'keydown',
  'touchstart',
  'touchmove',
] as const

export function useIdle(delayMs: number, enabled: boolean, held = false): boolean {
  const [idle, setIdle] = useState(false)
  const heldRef = useRef(held)
  heldRef.current = held

  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      return
    }

    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      // While the pointer is over the controls, keep re-arming rather than
      // going idle — someone is plainly still using them.
      timer = window.setTimeout(() => {
        if (heldRef.current) {
          arm()
          return
        }
        setIdle(true)
      }, delayMs)
    }

    const wake = () => {
      setIdle(false)
      arm()
    }

    for (const event of WAKE_EVENTS) {
      window.addEventListener(event, wake, { passive: true })
    }
    arm()

    return () => {
      window.clearTimeout(timer)
      for (const event of WAKE_EVENTS) window.removeEventListener(event, wake)
    }
  }, [delayMs, enabled])

  return idle
}
