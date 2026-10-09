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
