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

/** A rectangle in unrotated page points, top-left origin — the space annotation
    payloads use; the backend flips it to PDFium's origin at the boundary. */
export type PagePointsRect = {
  height: number
  left: number
  top: number
  width: number
}

/** Content turns by the page's `/Rotate`, and that whole box again by the
    reader's rotation; about a common centre, the two compose into one. */
export function totalPageRotation(page: PdfPageInfo, rotation: number) {
  return (((rotation + page.rotation) % 360) + 360) % 360
}

/** Quarter turns are the whole domain — the toolbar steps by 90°, `/Rotate` is a
    multiple of it — so this is a swap and a flip of fractions, not trigonometry. */
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

export function rotateFraction(
  fraction: BoxFraction,
  degrees: number,
): BoxFraction {
  switch (degrees) {
    case 90:
      return { x: 1 - fraction.y, y: fraction.x }
    case 180:
      return { x: 1 - fraction.x, y: 1 - fraction.y }
    case 270:
      return { x: fraction.y, y: 1 - fraction.x }
    default:
      return { x: fraction.x, y: fraction.y }
  }
}

function unrotatedPageSize(page: PdfPageInfo) {
  return dimensionsForRotation(page.rotation, page.width, page.height)
}

/** `fraction` is measured against the footprint box — the element carrying
    `data-page-number`, axis-aligned however the page inside it turns. */
export function fractionToPagePoint(
  fraction: BoxFraction,
  page: PdfPageInfo,
  rotation: number,
): PagePoint {
  const unrotated = unrotateFraction(fraction, totalPageRotation(page, rotation))
  const { height, width } = unrotatedPageSize(page)

  return { left: unrotated.x * width, top: unrotated.y * height }
}

/** The corners are resolved independently and then squared up: a rotation can
    carry one to any side of the other. */
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

/** The way back out of page space, so a screen-space text editor can sit over a
    page point — the page layer turns, and nobody wants to type at 90°. */
export function pagePointToFraction(
  point: PagePoint,
  page: PdfPageInfo,
  rotation: number,
): BoxFraction {
  const { height, width } = unrotatedPageSize(page)
  const unrotated = {
    x: width > 0 ? point.left / width : 0,
    y: height > 0 ? point.top / height : 0,
  }

  return rotateFraction(unrotated, totalPageRotation(page, rotation))
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

/** The inverse of `clientPointToFraction`, against the same box. */
export function fractionToClientPoint(
  box: { height: number; left: number; top: number; width: number },
  fraction: BoxFraction,
): { x: number; y: number } {
  return {
    x: box.left + fraction.x * box.width,
    y: box.top + fraction.y * box.height,
  }
}

/** Holds `fraction` inside its box, for a run that reached past the page's edge. */
export function clampFraction(fraction: BoxFraction): BoxFraction {
  return {
    x: Math.min(1, Math.max(0, fraction.x)),
    y: Math.min(1, Math.max(0, fraction.y)),
  }
}
