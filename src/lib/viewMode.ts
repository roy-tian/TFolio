import { rememberSettings, storedSettings } from "@/lib/settings"

export const viewModes = ["single", "book", "thumbnail"] as const

export type ViewMode = (typeof viewModes)[number]

export const defaultViewMode: ViewMode = "single"

/** The column gap holds the insertion line and its + button; the row gap is
    spent as cell bottom padding so every band belongs to a cell. */
export const THUMBNAIL_WIDTH = 160
export const THUMBNAIL_ROW_GAP = 16
export const THUMBNAIL_COLUMN_GAP = 32

/** In `rem`, not pixels, because the number is `text-xs`: a WebView whose
    root font size is not 16px keeps the box and the insertion line agreed. */
export const THUMBNAIL_CAPTION_HEIGHT = "1.375rem"

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
  viewMode: Exclude<ViewMode, "thumbnail">,
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

/** Rounded down to an even count, so a row never splits a spread; never
    fewer than two. */
export function computeThumbnailColumns(
  containerWidth: number,
  columnWidth = THUMBNAIL_WIDTH,
  gap = THUMBNAIL_COLUMN_GAP,
): number {
  // `n` columns occupy `n * columnWidth + (n - 1) * gap`, so lending the row one
  // extra gap makes the fit a plain division.
  const fit = Math.floor((containerWidth + gap) / (columnWidth + gap))

  return Math.max(2, Math.floor(fit / 2) * 2)
}
