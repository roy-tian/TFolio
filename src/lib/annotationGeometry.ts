import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"

/** A point inside a box, as a fraction of its size from the top-left corner. */
export type BoxFraction = {
  x: number
  y: number
}

/** A point in unrotated page points, from the page's top-left corner. */
export type PagePoint = {
  left: number
  top: number
}

/**
 * A rectangle in unrotated page points with a top-left origin — the space
 * `PdfTextSpan` reports text in, and the only space annotation payloads use.
 * The backend flips it to PDFium's bottom-left origin at the boundary.
 */
export type PagePointsRect = {
  height: number
  left: number
  top: number
  width: number
}

/**
 * The rotation between a page's own coordinates and what the reader sees.
 *
 * Content is rotated by the page's `/Rotate`, and that whole box again by the
 * reader's rotation. Rotations about a common centre compose, so undoing both
 * is one rotation rather than two nested ones.
 */
export function totalPageRotation(page: PdfPageInfo, rotation: number) {
  return (((rotation + page.rotation) % 360) + 360) % 360
}

/**
 * Where a point of a rotated box's footprint sits in the box's own coordinates.
 *
 * Quarter turns are the whole domain — the toolbar steps by 90° and `/Rotate` is
 * a multiple of it — which is what keeps this a swap and a flip of two fractions
 * rather than trigonometry that would only approximate the corners back.
 */
export function unrotateFraction(
  fraction: BoxFraction,
  degrees: number,
): BoxFraction {
  switch (degrees) {
    case 90:
      return { x: fraction.y, y: 1 - fraction.x }
    case 180:
      return { x: 1 - fraction.x, y: 1 - fraction.y }
    case 270:
      return { x: 1 - fraction.y, y: fraction.x }
    default:
      return { x: fraction.x, y: fraction.y }
  }
}

function unrotatedPageSize(page: PdfPageInfo) {
  return dimensionsForRotation(page.rotation, page.width, page.height)
}

/**
 * `fraction` is measured against the footprint box — the element carrying
 * `data-page-number`, which stays axis-aligned however the page inside it turns.
 */
export function fractionToPagePoint(
  fraction: BoxFraction,
  page: PdfPageInfo,
  rotation: number,
): PagePoint {
  const unrotated = unrotateFraction(fraction, totalPageRotation(page, rotation))
  const { height, width } = unrotatedPageSize(page)

  return { left: unrotated.x * width, top: unrotated.y * height }
}

/**
 * The corners are resolved independently and then squared up: a rotation can
 * carry one to any side of the other.
 */
export function fractionsToPageRect(
  from: BoxFraction,
  to: BoxFraction,
  page: PdfPageInfo,
  rotation: number,
): PagePointsRect {
  const start = fractionToPagePoint(from, page, rotation)
  const end = fractionToPagePoint(to, page, rotation)

  return {
    height: Math.abs(end.top - start.top),
    left: Math.min(start.left, end.left),
    top: Math.min(start.top, end.top),
    width: Math.abs(end.left - start.left),
  }
}

export function clientPointToFraction(
  box: { height: number; left: number; top: number; width: number },
  clientX: number,
  clientY: number,
): BoxFraction {
  return {
    x: box.width > 0 ? (clientX - box.left) / box.width : 0,
    y: box.height > 0 ? (clientY - box.top) / box.height : 0,
  }
}

/** Holds `fraction` inside its box, for a run that reached past the page's edge. */
export function clampFraction(fraction: BoxFraction): BoxFraction {
  return {
    x: Math.min(1, Math.max(0, fraction.x)),
    y: Math.min(1, Math.max(0, fraction.y)),
  }
}
