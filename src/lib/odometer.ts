/**
 * `place` is the power of ten, so a column keeps its identity across width
 * changes; a `from` of "" means the number never reached that far.
 */
export type OdometerColumn = {
  from: string
  place: number
  rolls: boolean
  to: string
}

/**
 * Only a changed digit `rolls`, which is what carries the size of the move:
 * 19 → 20 turns both places, 12 → 13 only the last.
 */
export function odometerColumns(from: number, to: number): OdometerColumn[] {
  const fromDigits = String(from)
  const toDigits = String(to)
  const width = Math.max(fromDigits.length, toDigits.length)

  return Array.from({ length: width }, (_, index) => {
    const place = width - 1 - index
    const fromDigit = fromDigits[fromDigits.length - 1 - place] ?? ""
    const toDigit = toDigits[toDigits.length - 1 - place] ?? ""

    return {
      from: fromDigit,
      place,
      rolls: fromDigit !== toDigit,
      to: toDigit,
    }
  })
}
