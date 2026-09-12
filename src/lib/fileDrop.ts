/**
 * An OS drag reports only a window position, so the target is hit-tested per
 * move: measuring every cell would be a cost a thousand-page drag cannot carry.
 */

export type DropHit =
  | { kind: "gap"; index: number }
  | { kind: "page"; pageNumber: number; left: number; width: number }

/**
 * A thumbnail counts as a target in its own right — the nearer edge wins — so
 * the whole grid is live, not only the thin gaps between cells.
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

/**
 * The cell, not the paper: a drop over the number or badge must name the page,
 * not fall to the workspace. `root` keeps a hidden tab's grid out of the answer.
 */
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
