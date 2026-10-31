export const DRAG_THRESHOLD = 4

export function exceedsDragThreshold(
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD
}

/** The gap a point falls in among stacked rows: before the first row whose
    midpoint is below it. `y` and the rows are content-space. */
export function dropGapForRow(
  y: number,
  rows: { height: number; top: number }[],
): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!

    if (y < row.top + row.height / 2) {
      return index
    }
  }

  return rows.length
}

/** The gap counts positions between the items as they stand, so every gap
    past the dragged item's own place shifts down by the hole it leaves. */
export function indexAfterMove(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap
}

/** A drop that reproduces the current order comes back as the identity,
    which the caller declines to commit. */
export function orderAfterMove(
  dragged: number[],
  gap: number,
  pageCount: number,
): number[] {
  const moving = new Set(dragged)
  const block = [...dragged].sort((left, right) => left - right)
  const remaining: number[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (!moving.has(pageNumber)) {
      remaining.push(pageNumber)
    }
  }

  // The gap counts positions between the pages as they stand; among the
  // remaining pages it falls after those numbered at or below it.
  const insertAt = remaining.filter((pageNumber) => pageNumber <= gap).length

  return [
    ...remaining.slice(0, insertAt),
    ...block,
    ...remaining.slice(insertAt),
  ]
}
