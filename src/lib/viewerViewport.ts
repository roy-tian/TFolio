/** The scroll box extends behind the tabs, but reading/navigation geometry
    starts below them. Its top padding also keeps the first page unobscured. */
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

/** What the vertical scrollbar takes, shown or not. Measured once off a scrolling
    twin of the viewer: whether its styling holds is the engine's call. */
function viewerScrollbarGutter(viewer: HTMLElement) {
  if (scrollbarGutter === undefined) {
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

/** The width pages are laid out in, the scrollbar's gutter held out whether or not
    it shows. Fitted to the client width, a document whose height rides the
    viewport's edge summons the bar by fitting wider and dismisses it by fitting
    narrower, every frame. */
export function viewerLayoutWidth(viewer: HTMLElement) {
  return Math.max(0, viewer.offsetWidth - viewerScrollbarGutter(viewer))
}

/** Whether the committed size is still the viewer's own, so what is measured now
    describes the layout React last made. */
export function viewerSizeCommitted(
  viewer: HTMLElement,
  committed: { height: number; width: number },
) {
  return (
    viewerLayoutWidth(viewer) === committed.width &&
    viewer.clientHeight === committed.height
  )
}
