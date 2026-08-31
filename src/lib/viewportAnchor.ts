/**
 * Holding the reader's place while the viewport itself changes.
 *
 * A point on a page is remembered rather than a scroll offset, because only the
 * page scales: the gaps and the column's padding around it are fixed, so an
 * offset cannot be scaled to predict where the point lands. Re-measuring the
 * page after the new layout is exact.
 */

/** A page's box on screen, the part of `getBoundingClientRect` this needs. */
export type AnchorRect = {
  height: number
  left: number
  top: number
  width: number
}

export type ViewportAnchor = {
  /** Where on screen the point sat when it was taken. */
  clientX: number
  clientY: number
  /** Where in the page the point sits, as a fraction of its box. Outside 0..1
      if the point was beside or above the page, which still resolves to the
      right correction. */
  fractionX: number
  fractionY: number
  pageNumber: number
}

/**
 * The point at `clientX`/`clientY`, as somewhere on `pageNumber`.
 *
 * Null for a page with no box to measure — one still mounting, or one in a
 * panel a hidden tab has collapsed — since nothing can be anchored to it.
 */
export function anchorOnPage(
  pageNumber: number,
  rect: AnchorRect,
  clientX: number,
  clientY: number,
): ViewportAnchor | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }

  return {
    clientX,
    clientY,
    fractionX: (clientX - rect.left) / rect.width,
    fractionY: (clientY - rect.top) / rect.height,
    pageNumber,
  }
}

/**
 * What to add to the viewer's scroll offsets for the anchored point to sit
 * where it did, given the page's box in the layout that has since been made.
 */
export function anchorCorrection(anchor: ViewportAnchor, rect: AnchorRect) {
  return {
    left: rect.left + anchor.fractionX * rect.width - anchor.clientX,
    top: rect.top + anchor.fractionY * rect.height - anchor.clientY,
  }
}
