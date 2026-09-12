import { useEffect, useState } from "react"

/**
 * Belongs at the viewer boundary, not inside every page: layout follows the
 * committed zoom while near-viewport canvases stretch until one size settles.
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
