import { isMacOS } from "@/lib/platform"

/** On `<html>` wherever the app draws its own bars over hidden native ones:
    everywhere but macOS, whose bars already overlay or are the user's choice. */
const EMULATED_CLASS = "emulated-scrollbars"

/** Big enough to grab however long the content runs. */
export const MIN_THUMB_SIZE = 24

/** Before the first render, so no box is laid out around a native bar first. */
export function applyScrollbarEmulation() {
  document.documentElement.classList.toggle(EMULATED_CLASS, !isMacOS())
}

export function scrollbarsEmulated() {
  return document.documentElement.classList.contains(EMULATED_CLASS)
}

/** The thumb along a track of `trackSize`, for a box showing `clientSize` of
    `scrollSize` from `scroll` on. */
export function thumbGeometry(
  scroll: number,
  scrollSize: number,
  clientSize: number,
  trackSize: number,
) {
  const size = Math.min(
    trackSize,
    Math.max(MIN_THUMB_SIZE, (trackSize * clientSize) / scrollSize),
  )
  const maxScroll = scrollSize - clientSize
  // An elastic overscroll reports offsets past either end.
  const progress = maxScroll > 0 ? Math.min(1, Math.max(0, scroll / maxScroll)) : 0

  return { offset: (trackSize - size) * progress, size }
}

/** How far a press at `pressed` along the track scrolls: a page toward it, as
    native bars do, but no further than brings the thumb's edge to the press.
    A box overflowing by less than a page, as a zoomed page does sideways,
    would otherwise reach its end from any press. */
export function trackPressScroll(
  pressed: number,
  thumbOffset: number,
  thumbSize: number,
  page: number,
  scrollPerPixel: number,
) {
  const reach =
    pressed < thumbOffset
      ? pressed - thumbOffset
      : Math.max(0, pressed - thumbOffset - thumbSize)
  const toPress = reach * scrollPerPixel

  return Math.sign(toPress) * Math.min(page, Math.abs(toPress))
}

/** How far the box scrolls for each pixel the thumb is dragged. */
export function scrollPerThumbPixel(
  scrollSize: number,
  clientSize: number,
  trackSize: number,
  thumbSize: number,
) {
  const travel = trackSize - thumbSize

  return travel > 0 ? (scrollSize - clientSize) / travel : 0
}
