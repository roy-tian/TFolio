/**
 * Geometry for dragging thumbnails into a new order. Cells are measured once
 * at drag start, in the grid's own coordinate space, and every later pointer
 * event is answered by pure math over that snapshot — never by polling the DOM
 * per move.
 */
export type CellBox = {
  left: number
  top: number
  width: number
  height: number
}

/** How far a press may wander and still be a click rather than a drag. */
export const DRAG_THRESHOLD = 4

export function exceedsDragThreshold(
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD
}

/**
 * The gap the pointer indicates: 0 is before page 1, `cells.length` after the
 * last page. The row is whichever vertical band the pointer is in (or nearest
 * to), and within it the boundary closest to the pointer wins.
 */
export function dropGapForPoint(
  point: { x: number; y: number },
  cells: CellBox[],
  columns: number,
): number {
  if (cells.length === 0 || columns < 1) {
    return 0
  }

  const rowCount = Math.ceil(cells.length / columns)
  let row = 0
  let rowDistance = Number.POSITIVE_INFINITY

  for (let candidate = 0; candidate < rowCount; candidate += 1) {
    const first = cells[candidate * columns]!
    const distance =
      point.y < first.top
        ? first.top - point.y
        : Math.max(0, point.y - (first.top + first.height))

    if (distance < rowDistance) {
      row = candidate
      rowDistance = distance
    }
  }

  const start = row * columns
  const rowCells = cells.slice(start, start + columns)
  // Boundaries sit at each cell's left edge plus one past the last cell; the
  // pointer picks whichever it is horizontally closest to.
  let boundary = rowCells.length

  for (let candidate = 0; candidate < rowCells.length; candidate += 1) {
    const cell = rowCells[candidate]!

    if (point.x < cell.left + cell.width / 2) {
      boundary = candidate
      break
    }
  }

  return start + boundary
}

/**
 * The 1-based page order after dropping `dragged` into `gap`. The dragged
 * pages land as one block, keeping their relative order; everything else keeps
 * its own. A drop that reproduces the current order comes back as the
 * identity, which the caller declines to commit.
 */
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
