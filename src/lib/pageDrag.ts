export const DRAG_THRESHOLD = 4

// A release's click lands within this of the drag's end; a later one is the
// reader's own, even when the drag ended elsewhere and sent no click.
export const DRAG_CLICK_WINDOW = 300

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

/** Where the first of the moving items, by ascending index, stands once they
    land together at `gap`. The gap counts positions between the items as they
    stand, so each moving item before it shifts it down by the hole it leaves. */
export function indexAfterMove(moving: readonly number[], gap: number): number {
  return gap - moving.filter((index) => index < gap).length
}

/** Only a run with no gaps in it, landing on its own first place, leaves
    every item where it stands. */
export function movesNothing(moving: readonly number[], to: number): boolean {
  return moving.every((index, offset) => index === to + offset)
}

/**
 * How far each item slides to make way for the moving items, by ascending
 * index, landing together at `to`. An item passed over moves by each passing
 * item's own extent, not its neighbour's: the organize list's files differ in
 * height by their bookmarks. The moving items stay put, hidden under the ghost.
 */
export function wayOffsets(
  moving: readonly number[],
  to: number,
  cells: readonly { height: number; top: number }[],
): number[] {
  const lifted = new Set(moving)
  const staying = cells.flatMap((_, index) => (lifted.has(index) ? [] : [index]))
  const order = [...staying.slice(0, to), ...moving, ...staying.slice(to)]
  const place: number[] = []

  order.forEach((index, at) => {
    place[index] = at
  })

  return cells.map((_, index) => {
    let offset = 0

    if (lifted.has(index)) {
      return offset
    }

    for (const item of moving) {
      const cell = cells[item]!

      if (item > index && place[item]! < place[index]!) {
        const before = cells[item - 1]!

        offset += cell.top + cell.height - (before.top + before.height)
      } else if (item < index && place[item]! > place[index]!) {
        offset += cell.top - cells[item + 1]!.top
      }
    }

    return offset
  })
}

/** A drop that reproduces the current order comes back as the identity,
    which the caller declines to commit. */
export function orderAfterMove(
  dragged: number[],
  gap: number,
  pageCount: number,
): number[] {
  const moving = new Set(dragged)
  let at = 0

  // The gap counts positions between the pages as they stand; among the
  // remaining pages it falls after those numbered at or below it.
  for (let pageNumber = 1; pageNumber <= Math.min(gap, pageCount); pageNumber += 1) {
    if (!moving.has(pageNumber)) {
      at += 1
    }
  }

  return orderWithBlockAt(dragged, at, pageCount)
}

/** The pages in order once a block lands `at` among the pages that stay. */
export function orderWithBlockAt(
  block: number[],
  at: number,
  pageCount: number,
): number[] {
  const moving = new Set(block)
  const remaining: number[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (!moving.has(pageNumber)) {
      remaining.push(pageNumber)
    }
  }

  return [
    ...remaining.slice(0, at),
    ...[...block].sort((left, right) => left - right),
    ...remaining.slice(at),
  ]
}

type Box = { height: number; left: number; top: number; width: number }

/**
 * Where among the rows that stay a block lands, for a pointer over a column
 * already laid out with the block where it last landed. Over the block's own
 * holes the answer stays `current`: the rows slide under a still pointer, and
 * the landing must not chase them.
 */
export function columnLanding(
  y: number,
  rows: (Pick<Box, "height" | "top"> & { moving: boolean })[],
  current: number | null,
): number | null {
  let staying = 0

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const next = rows[index + 1]
    // Halfway across the gap, so every point belongs to some row.
    const limit = next
      ? (row.top + row.height + next.top) / 2
      : Number.POSITIVE_INFINITY

    if (y < limit) {
      if (row.moving) {
        return current
      }

      return y < row.top + row.height / 2 ? staying : staying + 1
    }

    if (!row.moving) {
      staying += 1
    }
  }

  return current
}

/**
 * The cell a point is over in a flex-wrap flow, nearest by row and then by
 * column: gaps go to the closer neighbour, and points beyond the flow to its
 * edge cells. `after` once past the cell's middle.
 */
export function flowCellAt(
  point: { x: number; y: number },
  cells: Box[],
): { after: boolean; index: number } | null {
  if (cells.length === 0) {
    return null
  }

  // A cell no further right than the one before it opened a new line.
  const rows: { bottom: number; first: number; last: number; top: number }[] = []

  cells.forEach((cell, index) => {
    const row = rows.at(-1)

    if (row && cell.left > cells[index - 1]!.left) {
      row.last = index
      row.top = Math.min(row.top, cell.top)
      row.bottom = Math.max(row.bottom, cell.top + cell.height)
    } else {
      rows.push({ bottom: cell.top + cell.height, first: index, last: index, top: cell.top })
    }
  })

  const row =
    rows.find((candidate, index) => {
      const next = rows[index + 1]

      return !next || point.y < (candidate.bottom + next.top) / 2
    }) ?? rows.at(-1)!

  for (let index = row.first; index <= row.last; index += 1) {
    const cell = cells[index]!
    const next = index < row.last ? cells[index + 1]! : undefined

    if (!next || point.x < (cell.left + cell.width + next.left) / 2) {
      return { after: point.x > cell.left + cell.width / 2, index }
    }
  }

  return null
}
