/** Where a key leads among rows of unequal length: left and right run on
    through a row's ends as reading does, up and down keep the column, or take
    a shorter row's last cell. Null where the key moves nothing. */
export function stepInRows<T>(
  rows: ReadonlyArray<ReadonlyArray<T>>,
  current: T,
  key: string,
): T | null {
  const cells = rows.flat()
  const index = cells.indexOf(current)
  const row = rows.findIndex((cellsOfRow) => cellsOfRow.includes(current))

  if (index < 0) {
    return null
  }

  const column = rows[row].indexOf(current)
  const inRow = (target: number) => {
    const cellsOfRow = rows[target]

    return cellsOfRow?.[Math.min(column, cellsOfRow.length - 1)]
  }
  const next =
    key === "ArrowRight"
      ? cells[index + 1]
      : key === "ArrowLeft"
        ? cells[index - 1]
        : key === "ArrowDown"
          ? inRow(row + 1)
          : key === "ArrowUp"
            ? inRow(row - 1)
            : key === "Home"
              ? cells[0]
              : key === "End"
                ? cells[cells.length - 1]
                : undefined

  return next === undefined || next === current ? null : next
}
