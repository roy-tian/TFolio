import { useEffect, useState } from "react"

/**
 * `value`, held back until it has gone `delayMs` without changing.
 *
 * This hook belongs at the viewer boundary, not inside every page. Layout can
 * follow the committed zoom immediately while the handful of near-viewport
 * surfaces keep stretching their existing canvases until one final render size
 * settles for the whole document.
 */
export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    if (settled === value) {
      return
    }

    const timer = setTimeout(() => setSettled(value), delayMs)

    return () => clearTimeout(timer)
  }, [delayMs, settled, value])

  return settled
}
