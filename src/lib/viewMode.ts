import { rememberSettings, storedSettings } from "@/lib/settings"

export const viewModes = ["single", "book"] as const

export type ViewMode = (typeof viewModes)[number]

export const defaultViewMode: ViewMode = "single"

/** The long side of a thumbnail's paper, whichever way the page is turned. */
export const THUMBNAIL_WIDTH = 160

/** In `rem`, not pixels, because the number is `text-xs`: a WebView whose
    root font size is not 16px keeps the box the same height as its text. */
export const THUMBNAIL_CAPTION_HEIGHT = "1.375rem"

/** CSS pixels per point of a thumbnail: its long side spans the column, so a
    page keeps its scale whichever way it is turned. */
function thumbnailScale(page: { height: number; width: number }) {
  return THUMBNAIL_WIDTH / Math.max(page.width, page.height)
}

export function thumbnailPaper(page: { height: number; width: number }) {
  const scale = thumbnailScale(page)

  return { height: page.height * scale, width: page.width * scale }
}

export function isViewMode(value: unknown): value is ViewMode {
  return viewModes.includes(value as ViewMode)
}

export function hasBookSpread(numPages: number): boolean {
  return numPages > 1
}

/**
 * A one-page document has no spread, so the viewer outvotes book view — but
 * the choice stays standing, and inserting a page brings book view back.
 */
export function effectiveViewMode(
  preferred: ViewMode,
  numPages: number,
): ViewMode {
  return preferred === "book" && !hasBookSpread(numPages) ? "single" : preferred
}

export function readStoredViewMode(): ViewMode | null {
  const stored = storedSettings().ui?.viewMode

  return isViewMode(stored) ? stored : null
}

export function storeViewMode(mode: ViewMode) {
  rememberSettings({ ui: { viewMode: mode } })
}

/** A single-page turn; a book turn goes by spreads (`spreadTurnTarget`).
    Page Up/Down turn pages, not pixels. */
export function pageTurnTarget(
  pageNumber: number,
  numPages: number,
  direction: -1 | 1,
): number {
  const lastPage = Math.max(1, numPages)
  const current = Math.min(lastPage, Math.max(1, pageNumber))

  return Math.min(lastPage, Math.max(1, current + direction))
}
