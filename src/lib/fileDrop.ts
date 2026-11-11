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

/** On the shown tab's pages, down the sidebar or across the grid, a drop adds
    the dragged files to that tab's document instead of opening them. */
const PAGES_SELECTOR = "[data-document-session][data-active='true'] [data-pages-surface]"

export function pagesShown() {
  return (document.querySelector(PAGES_SELECTOR)?.getClientRects().length ?? 0) > 0
}

/** Drop overlays take no pointer events, so the hit lands on what they cover. */
export function overPages(point: { x: number; y: number }) {
  return (document.elementFromPoint(point.x, point.y)?.closest(PAGES_SELECTOR) ?? null) !== null
}

const GRID_SELECTOR = "[data-document-session][data-active='true'] [data-page-thumbnails='grid']"

/** Whether those pages are the page grid, filling the main area: a drop meant
    to open its files then has only the bars around the grid to land on. */
export function pagesFillWorkspace() {
  return (document.querySelector(GRID_SELECTOR)?.getClientRects().length ?? 0) > 0
}
