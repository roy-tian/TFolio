import { useEffect, useRef, useState } from "react"

/**
 * Belongs at the viewer boundary, not inside every page: layout follows the
 * committed zoom while near-viewport canvases stretch until one size settles.
 * A change that comes with a new `leadingKey` after a quiet spell passes at
 * once — a zoom the reader asked for — and only what follows it waits.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number,
  leadingKey?: unknown,
) {
  const [settled, setSettled] = useState(value)
  const keyRef = useRef(leadingKey)
  const valueRef = useRef(value)
  const changedAtRef = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    const asked = keyRef.current !== leadingKey
    keyRef.current = leadingKey
    // Timed by the value, not by this effect: a key bumped without a new
    // value (`+` held at the maximum) must not restart the wait.
    const now = performance.now()
    const changed = valueRef.current !== value
    const quiet = changed && now - changedAtRef.current >= delayMs
    valueRef.current = value

    if (changed) {
      changedAtRef.current = now
    }

    if (settled === value) {
      return
    }

    if (asked && quiet) {
      setSettled(value)
      return
    }

    const timer = setTimeout(
      () => setSettled(value),
      Math.max(0, changedAtRef.current + delayMs - now),
    )

    return () => clearTimeout(timer)
  }, [delayMs, leadingKey, settled, value])

  return settled
}
