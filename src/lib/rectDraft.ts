import type { BoxFraction, PagePointsRect } from "@/lib/annotationGeometry"

export type FractionRect = {
  height: number
  left: number
  top: number
  width: number
}

/**
 * Whichever way round the corners were dragged: a drag up and left is the same
 * box as one down and right, so the corners are squared up, not trusted.
 */
export function normalizeFractionRect(
  from: BoxFraction,
  to: BoxFraction,
): FractionRect {
  return {
    height: Math.abs(to.y - from.y),
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
  }
}

/** Below this, on either side, a drag is a stray click rather than a rectangle. */
export const MIN_RECT_POINTS = 3

export function isRectLargeEnough(rect: PagePointsRect): boolean {
  return rect.width >= MIN_RECT_POINTS && rect.height >= MIN_RECT_POINTS
}
