import type { PdfSearchMatch } from "@/lib/pdf"

/** Starts at the first occurrence on or after the page being read, wrapping to
    the document's beginning when every occurrence is earlier. */
export function firstSearchMatchFromPage(
  matches: PdfSearchMatch[],
  currentPage: number,
) {
  if (matches.length === 0) {
    return null
  }

  const index = matches.findIndex((match) => match.pageNumber >= currentPage)

  return index === -1 ? 0 : index
}

/** Moves through occurrences in document order and wraps at either end. */
export function stepSearchMatch(
  current: number | null,
  count: number,
  direction: -1 | 1,
) {
  if (count <= 0) {
    return null
  }

  const index = current === null ? (direction === 1 ? -1 : 0) : current

  return (index + direction + count) % count
}

/** A box on screen, the part of `getBoundingClientRect` these need. */
export type SearchBox = {
  bottom: number
  left: number
  right: number
  top: number
}

/** The box around every rectangle of one occurrence, when it fits on screen. */
export function searchMatchBox(rects: SearchBox[]): SearchBox | null {
  if (rects.length === 0) {
    return null
  }

  return rects.reduce((box, rect) => ({
    bottom: Math.max(box.bottom, rect.bottom),
    left: Math.min(box.left, rect.left),
    right: Math.max(box.right, rect.right),
    top: Math.min(box.top, rect.top),
  }))
}

/** Fractional page geometry must not read as a clipped edge. */
const EDGE_TOLERANCE = 0.5

/** Zero while the axis shows as much of the box as it can hold, which leaves a
    result larger than the viewport alone once it covers it. */
function axisOffset(
  start: number,
  end: number,
  viewStart: number,
  viewEnd: number,
  forced: boolean,
) {
  const shown = Math.min(end, viewEnd) - Math.max(start, viewStart)
  const showable = Math.min(end - start, viewEnd - viewStart)

  if (!forced && shown + EDGE_TOLERANCE >= showable) {
    return 0
  }

  return (start + end) / 2 - (viewStart + viewEnd) / 2
}

export type SearchScrollBounds = {
  minLeft: number
  maxLeft: number
  minTop: number
  maxTop: number
}

const UNBOUNDED_SCROLL: SearchScrollBounds = {
  minLeft: -Infinity,
  maxLeft: Infinity,
  minTop: -Infinity,
  maxTop: Infinity,
}

function boxRevealOffset(
  match: SearchBox,
  viewport: SearchBox,
  covered: SearchBox | null,
  bounds: SearchScrollBounds,
) {
  const left = Math.max(bounds.minLeft, Math.min(bounds.maxLeft, axisOffset(
    match.left,
    match.right,
    viewport.left,
    viewport.right,
    false,
  )))
  let top = Math.max(bounds.minTop, Math.min(bounds.maxTop, axisOffset(
    match.top,
    match.bottom,
    viewport.top,
    viewport.bottom,
    false,
  )))

  // The bar is fixed: test where the result will land, not where it starts.
  const hidden =
    covered !== null &&
    match.left - left < covered.right &&
    match.right - left > covered.left &&
    match.top - top < covered.bottom &&
    match.bottom - top > covered.top

  if (hidden) {
    top = Math.max(bounds.minTop, Math.min(bounds.maxTop, axisOffset(
      match.top,
      match.bottom,
      viewport.top,
      viewport.bottom,
      true,
    )))
  }

  return left === 0 && top === 0 ? null : { left, top }
}

function boxIsVisible(
  match: SearchBox,
  viewport: SearchBox,
  covered: SearchBox | null,
) {
  return (
    axisOffset(match.left, match.right, viewport.left, viewport.right, false) === 0 &&
    axisOffset(match.top, match.bottom, viewport.top, viewport.bottom, false) === 0 &&
    !(covered &&
      match.left < covered.right && match.right > covered.left &&
      match.top < covered.bottom && match.bottom > covered.top)
  )
}

/** Reveal the whole occurrence if it fits; otherwise prefer a reachable segment.
    Bounds are allowable deltas from current scroll. */
export function searchRevealOffset(
  rects: SearchBox[],
  viewport: SearchBox,
  covered: SearchBox | null = null,
  bounds: SearchScrollBounds = UNBOUNDED_SCROLL,
) {
  const match = searchMatchBox(rects)

  if (!match) {
    return null
  }

  if (
    match.right - match.left <= viewport.right - viewport.left + EDGE_TOLERANCE &&
    match.bottom - match.top <= viewport.bottom - viewport.top + EDGE_TOLERANCE
  ) {
    return boxRevealOffset(match, viewport, covered, bounds)
  }

  if (rects.some((rect) => boxIsVisible(rect, viewport, covered))) {
    return null
  }

  const offsets = rects.map((rect) => boxRevealOffset(rect, viewport, covered, bounds))

  // A clamped move (including zero) need not expose its segment at the destination.
  return offsets.find((offset, index) => {
    const rect = rects[index]
    return offset && boxIsVisible({
      left: rect.left - offset.left,
      right: rect.right - offset.left,
      top: rect.top - offset.top,
      bottom: rect.bottom - offset.top,
    }, viewport, covered)
  }) ?? offsets[0]
}
