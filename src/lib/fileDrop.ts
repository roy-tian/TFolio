/** Where a file drag stands, in CSS pixels. Tauri types every position as
    physical but passes on each backend's own: WebKitGTK and WKWebView report
    view points, WebView2 alone device pixels. */
export function dropPointInCss(
  position: { x: number; y: number },
  windows: boolean,
  scale: number,
) {
  return windows && scale > 0
    ? { x: position.x / scale, y: position.y / scale }
    : { x: position.x, y: position.y }
}

/** On the shown tab's sidebar pages, a drop combines the dragged files with
    that tab's own instead of opening them. */
const PAGES_SELECTOR = "[data-document-session][data-active='true'] [data-sidebar-pages]"

export function sidebarPagesShown() {
  return (document.querySelector(PAGES_SELECTOR)?.getClientRects().length ?? 0) > 0
}

/** Drop overlays take no pointer events, so the hit lands on what they cover. */
export function overSidebarPages(point: { x: number; y: number }) {
  return (document.elementFromPoint(point.x, point.y)?.closest(PAGES_SELECTOR) ?? null) !== null
}
