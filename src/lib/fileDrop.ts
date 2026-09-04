/**
 * Where a PDF dragged in from the desktop would go in the thumbnail grid.
 *
 * The OS drag reports a window position and nothing else — no element, no
 * pointer events — so the target is found by hit-testing that point and asking
 * what it landed on. Unlike the grid's own page drag, which measures every cell
 * once at the start, this reads only what is under the pointer: an OS drag can
 * cross a thousand-page grid, and measuring it per move is a cost no drag can
 * carry.
 */

/** What the pointer is over: a gap between cells, which names its own position,
    or a thumbnail, whose nearer vertical edge names one. */
export type DropHit =
  | { kind: "gap"; index: number }
  | { kind: "page"; pageNumber: number; left: number; width: number }

/**
 * The 1-based position a dropped file's first page would take, or null when the
 * pointer is over neither a gap nor a page. A thumbnail counts as a target in
 * its own right — the nearer edge wins — so the whole grid is live rather than
 * only the thin gaps, which is the difference between a drop that lands and one
 * the reader has to aim for.
 */
export function insertIndexForHit(hit: DropHit | null, x: number): number | null {
  if (!hit) {
    return null
  }

  if (hit.kind === "gap") {
    return hit.index
  }

  return x < hit.left + hit.width / 2 ? hit.pageNumber : hit.pageNumber + 1
}

/** Hit-tests `point` in the page, in CSS pixels, and reports what the grid has
    there. `root` bounds the answer to one document's viewer, so a drag over an
    inactive tab's grid — hidden, but still in the tree — finds nothing.

    The cell is read off `data-page-cell`, which the grid puts on the whole cell,
    rather than off `data-page-number`, which sits on the paper alone: the page
    number under a thumbnail and the badge over its corner are siblings of the
    paper, and a drop over either must still name the page it belongs to instead
    of falling through to the workspace as a tab. */
export function dropHitAt(
  point: { x: number; y: number },
  root: HTMLElement,
): DropHit | null {
  const element = document.elementFromPoint(point.x, point.y)

  if (!element || !root.contains(element)) {
    return null
  }

  const zone = element.closest<HTMLElement>("[data-insert-index]")

  if (zone) {
    const index = Number(zone.dataset.insertIndex)

    return Number.isInteger(index) && index >= 1 ? { kind: "gap", index } : null
  }

  const cell = element.closest<HTMLElement>("[data-page-cell]")

  if (!cell) {
    return null
  }

  const pageNumber = Number(cell.dataset.pageCell)

  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return null
  }

  const rect = cell.getBoundingClientRect()

  return { kind: "page", left: rect.left, pageNumber, width: rect.width }
}
