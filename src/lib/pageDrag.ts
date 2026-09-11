/**
 * Cells are measured once at drag start; every later pointer event is
 * answered by pure math over that snapshot, never by polling the DOM.
 */
export type CellBox = {
  left: number
  top: number
  width: number
  height: number
}

/**
 * How long a drag has to rest on a tab before the workspace opens it: long
 * enough that crossing the strip opens nothing, short enough to read as an answer.
 */
export const TAB_SPRING_MS = 600

export type PageHandoffPlace = "grid" | "carried"

/**
 * The workspace answers for the strip and the showing document, so a grid
 * never has to know that another document exists.
 */
export type PageHandoff = {
  /** How the workspace has the drag at this point, or null while the grid it
      started in still owns it — a release there being a reorder, not a drop. */
  claim: (point: { x: number; y: number }) => PageHandoffPlace | null
  drop: (point: { x: number; y: number }, pages: number[]) => void
  cancel: () => void
}

export const DRAG_THRESHOLD = 4

export function exceedsDragThreshold(
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  return Math.hypot(to.x - from.x, to.y - from.y) > DRAG_THRESHOLD
}

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

/** A stack of rows wants row midpoints, not the horizontal boundaries
    `dropGapForPoint` answers with. `y` and the rows are content-space. */
export function dropGapForRow(
  y: number,
  rows: Pick<CellBox, "height" | "top">[],
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

/**
 * The boxes are the drag-start ones: a preview that re-measured mid-gesture
 * would chase its own movement. Lifted pages travel with the pointer, so no slot.
 */
export function slotOffsets(
  order: number[],
  cells: CellBox[],
  lifted: ReadonlySet<number>,
): Map<number, { x: number; y: number }> {
  const offsets = new Map<number, { x: number; y: number }>()

  for (let slot = 0; slot < order.length; slot += 1) {
    const pageNumber = order[slot]!
    const from = cells[pageNumber - 1]
    const to = cells[slot]

    if (!from || !to || lifted.has(pageNumber)) {
      continue
    }

    const x = to.left - from.left
    const y = to.top - from.top

    if (x !== 0 || y !== 0) {
      offsets.set(pageNumber, { x, y })
    }
  }

  return offsets
}
