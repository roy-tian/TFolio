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

/**
 * How long a drag has to rest on a tab before the workspace opens it. Long
 * enough that crossing the strip on the way somewhere else opens nothing, short
 * enough to read as an answer rather than a wait.
 */
export const TAB_SPRING_MS = 600

/**
 * What the workspace is doing with a drag it has taken: the pages are over a
 * grid that would take them where the pointer is, or merely being carried —
 * over the strip, or over a document with no gap under the pointer.
 */
export type PageHandoffPlace = "grid" | "carried"

/**
 * Where a page drag goes once it leaves the grid it started in. The workspace
 * answers for the tab strip and for whichever document is showing, so a grid
 * never has to know that another document exists: it asks whether the drag is
 * still its own, and hands over the release when it is not.
 */
export type PageHandoff = {
  /** How the workspace has the drag at this point, or null while the grid it
      started in still owns it — a release there being a reorder, not a drop. */
  claim: (point: { x: number; y: number }) => PageHandoffPlace | null
  /** The release, when claimed. */
  drop: (point: { x: number; y: number }, pages: number[]) => void
  /** The gesture ended somewhere the workspace has no claim to. */
  cancel: () => void
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
 * The gap a pointer at `y` indicates in a single-column list: 0 above the first
 * row, `rows.length` below the last. Each row's own midpoint is the boundary,
 * which is what a stack of rows wants — `dropGapForPoint` answers with the
 * *horizontal* midpoint, right for a cell in a grid row and meaningless here.
 *
 * `y` and the rows are in the scroll container's content space, so a list the
 * reader scrolls mid-drag still answers about the row under the pointer.
 */
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

/**
 * Where the item at `from` lands when dropped into `gap`, both 0-based. The gap
 * counts the positions between the items as they stand, so one past the dragged
 * item's own place is where it already is — every gap beyond that shifts down by
 * the hole the item leaves behind.
 */
export function indexAfterMove(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap
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

/**
 * How far each page has to slide for the grid to read as `order`: the page
 * standing in slot i moves to the box of the slot `order` gives it, which is
 * what opens a hole where the drop would land. Keyed by 1-based page number.
 *
 * The boxes are the ones measured at drag start, so a page lands exactly on a
 * slot that is really there — a preview that re-measured mid-gesture would
 * chase its own movement. Pages already in place, and any page in `lifted` —
 * travelling with the pointer, so it has no slot to slide to — are left out.
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
