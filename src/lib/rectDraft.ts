import type { BoxFraction, PagePointsRect } from "@/lib/annotationGeometry"

/** A rectangle as fractions of its page's box, for positioning the live preview. */
export type FractionRect = {
  height: number
  left: number
  top: number
  width: number
}

/**
 * The rectangle between two dragged corners, whichever way round they were
 * dragged: a drag up and to the left describes the same box as one down and to
 * the right, so the corners are squared up rather than trusted to be in order.
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

/** Whether a committed rectangle is big enough to have been meant. */
export function isRectLargeEnough(rect: PagePointsRect): boolean {
  return rect.width >= MIN_RECT_POINTS && rect.height >= MIN_RECT_POINTS
}
