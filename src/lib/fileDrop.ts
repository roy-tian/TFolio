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

/** The window's sidebar: the home tab's or the shown document's, a hidden
    tab's having no box and a hidden sidebar no element. */
const SIDEBAR_SELECTOR = "[data-slot='app-sidebar']"

/** Within it, what the shown tab lists for a drop to land between two of:
    its pages, or the files of its outline, with the overlay scrollbar over
    their edge. Elsewhere on it, files go last. */
const BETWEEN_SELECTOR = "[data-document-session][data-active='true'] [data-sidebar-drop-list]"

export function sidebarShown() {
  return [...document.querySelectorAll(SIDEBAR_SELECTOR)].some(
    (sidebar) => sidebar.getClientRects().length > 0,
  )
}

/** What a file drag stands over, from one hit test per report. Drop overlays
    take no pointer events, so the hit lands on what they cover. */
export function dropHit(point: { x: number; y: number }) {
  const hit = document.elementFromPoint(point.x, point.y)

  return {
    between: (hit?.closest(BETWEEN_SELECTOR) ?? null) !== null,
    sidebar: (hit?.closest(SIDEBAR_SELECTOR) ?? null) !== null,
  }
}
