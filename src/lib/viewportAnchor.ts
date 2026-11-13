/**
 * A point on a page, not a scroll offset: only the page scales, so an
 * offset cannot predict where the point lands after a new layout.
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
  /** Where in the page the point sits, as a fraction of its box; outside 0..1
      if the point sat beside the page, which still corrects the right way. */
  fractionX: number
  fractionY: number
  pageNumber: number
}

/** Null for a page with no box to measure — still mounting, or collapsed
    by a hidden tab — since nothing can be anchored to it. */
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

/** What to add to scroll for the anchored point to sit where it did, given
    the page's box in the layout made since. */
export function anchorCorrection(anchor: ViewportAnchor, rect: AnchorRect) {
  return {
    left: rect.left + anchor.fractionX * rect.width - anchor.clientX,
    top: rect.top + anchor.fractionY * rect.height - anchor.clientY,
  }
}

/** The line down a page an edit holds still on screen. */
export type EditAnchor = Pick<ViewportAnchor, "clientY" | "fractionY" | "pageNumber">

/**
 * The page being read is held at the line it is read from: its own top while
 * that shows, else the viewer's top edge, at the same share of the page however
 * a fit rescales it. A page taken out (`replaced`) hands its place to
 * `pageNumber` from that page's top, never from partway down another page.
 */
export function editAnchor(
  pageNumber: number,
  rect: AnchorRect,
  readingTop: number,
  replaced = false,
): EditAnchor | null {
  if (rect.height <= 0) {
    return null
  }

  const clientY = Math.max(rect.top, readingTop)

  return {
    clientY,
    fractionY: replaced ? 0 : (clientY - rect.top) / rect.height,
    pageNumber,
  }
}

/** What to add to the scroll for the anchored line to sit where it did. */
export function editAnchorCorrection(anchor: EditAnchor, rect: AnchorRect) {
  return rect.top + anchor.fractionY * rect.height - anchor.clientY
}
