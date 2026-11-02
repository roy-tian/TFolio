import { scrollbarsEmulated } from "@/lib/overlayScrollbars"

/**
 * Sent on `window` just before a change moves the viewer's left edge, while the
 * old layout still stands. The resize observer reports only the moved box, its
 * pages already carried along by the scroll offset the browser keeps.
 */
export const VIEWER_WILL_MOVE_EVENT = "tfolio:viewer-will-move"

/** Reading and navigation geometry starts below the scroll box's top
    padding, should it ever have any. */
export function viewerTopInset(viewer: HTMLElement) {
  return Number.parseFloat(getComputedStyle(viewer).paddingTop) || 0
}

export function viewerReadingBounds(viewer: HTMLElement) {
  const rect = viewer.getBoundingClientRect()
  const inset = viewerTopInset(viewer)

  return new DOMRect(
    rect.x,
    rect.y + inset,
    rect.width,
    Math.max(0, rect.height - inset),
  )
}

let scrollbarGutter: number | undefined

/** What the vertical scrollbar takes, shown or not: nothing where the app draws
    its own over the pages. Measured off a scrolling twin of the viewer, since
    whether its styling holds is the engine's call. */
function viewerScrollbarGutter(viewer: HTMLElement, remeasure: boolean) {
  if (scrollbarGutter === undefined || (remeasure && !scrollbarsEmulated())) {
    const twin = document.createElement("div")
    twin.className = viewer.className
    Object.assign(twin.style, {
      height: "100px",
      left: "0",
      overflowY: "scroll",
      position: "fixed",
      top: "0",
      visibility: "hidden",
      width: "100px",
    })
    document.body.append(twin)
    scrollbarGutter = twin.offsetWidth - twin.clientWidth
    twin.remove()
  }

  return scrollbarGutter
}

/** The box pages are laid out in, the same whichever scrollbars show. The
    vertical bar's gutter is held out: fitted to the client width, a document
    whose height rides the viewport's edge summons the bar by fitting wider and
    dismisses it by fitting narrower, every frame. The height is the box's own:
    only a custom zoom overflows sideways, and no height decides its layout.

    macOS turns its bars from overlay to legacy and back as a mouse comes and
    goes, so a resize remeasures the gutter: a stale zero would bring the loop
    back. */
export function viewerLayoutSize(viewer: HTMLElement, remeasureGutter = false) {
  return {
    height: viewer.offsetHeight,
    width: Math.max(0, viewer.offsetWidth - viewerScrollbarGutter(viewer, remeasureGutter)),
  }
}

/** Whether the committed size is still the viewer's own, so what is measured now
    describes the layout React last made. */
export function viewerSizeCommitted(
  viewer: HTMLElement,
  committed: { height: number; width: number },
) {
  const size = viewerLayoutSize(viewer)

  return size.width === committed.width && size.height === committed.height
}
