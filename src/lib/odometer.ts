/**
 * One decimal place of a number on its way from one value to another.
 *
 * `place` is the power of ten rather than the position in the row, so a column
 * keeps its identity when the number gains or loses a digit: 9 → 10 rolls the
 * ones column that was already there and opens a tens column beside it, whose
 * `from` is empty because the number did not reach that far.
 */
export type OdometerColumn = {
  from: string
  place: number
  rolls: boolean
  to: string
}

/**
 * The columns a number turns through, most significant first, wide enough for
 * both values.
 *
 * Only a column whose digit actually changes `rolls`. That is what carries the
 * size of the move: 19 → 20 turns both places, 12 → 13 only the last, and a
 * reader sees the difference without reading either number.
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
