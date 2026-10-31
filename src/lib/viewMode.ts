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
function thumbnailScale(page: { height: number; width: number }, longSide: number) {
  return longSide / Math.max(page.width, page.height)
}

export function thumbnailPaper(
  page: { height: number; width: number },
  longSide = THUMBNAIL_WIDTH,
) {
  const scale = thumbnailScale(page, longSide)

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

/** A trailing odd page keeps the left slot of its own row, so it stays the
    same size as the pages above it. */
export function pairPages(numPages: number): number[][] {
  const rows: number[][] = []

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 2) {
    rows.push(spreadPages(pageNumber, numPages))
  }

  return rows
}

export function spreadPages(pageNumber: number, numPages: number): number[] {
  const first = pageNumber % 2 === 1 ? pageNumber : pageNumber - 1

  return first === numPages ? [first] : [first, first + 1]
}

/**
 * A book turn advances one spread and names its left page, so either half
 * being current gives the same answer; Page Up/Down turn pages, not pixels.
 */
export function pageTurnTarget(
  pageNumber: number,
  numPages: number,
  viewMode: ViewMode,
  direction: -1 | 1,
): number {
  const lastPage = Math.max(1, numPages)
  const current = Math.min(lastPage, Math.max(1, pageNumber))

  if (viewMode === "single") {
    return Math.min(lastPage, Math.max(1, current + direction))
  }

  const spreadStart = current % 2 === 1 ? current : current - 1
  const lastSpreadStart = lastPage % 2 === 1 ? lastPage : lastPage - 1

  return Math.min(lastSpreadStart, Math.max(1, spreadStart + direction * 2))
}
