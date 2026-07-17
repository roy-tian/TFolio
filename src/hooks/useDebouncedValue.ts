import { useEffect, useState } from "react"

/**
 * `value`, held back until it has gone `delayMs` without changing.
 *
 * The first value is passed straight through, and so is any change that lands
 * after things have settled: the delay is only ever paid by a burst. That is
 * what lets a caller drive layout from the live value and rendering from this
 * one — the two agree except while the value is actually moving.
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
