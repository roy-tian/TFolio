import { rememberSettings, storedSettings } from "@/lib/settings"

export const viewModes = ["single", "book", "thumbnail"] as const

export type ViewMode = (typeof viewModes)[number]

export const defaultViewMode: ViewMode = "single"

/** Width of one thumbnail cell, and the gaps around it, in CSS pixels. The
    columns stand further apart than the rows: the space between two pages is
    where the insertion line and its + button live, and it matches the layout's
    own side padding so the gap after the last page is the same width. The row
    gap is spent as each cell's bottom padding rather than the grid's `rowGap`,
    so that no band between two rows belongs to no cell — a file dragged across
    the grid has to name a position the whole way down. */
export const THUMBNAIL_WIDTH = 160
export const THUMBNAIL_ROW_GAP = 16
export const THUMBNAIL_COLUMN_GAP = 32

export function isViewMode(value: unknown): value is ViewMode {
  return viewModes.includes(value as ViewMode)
}

/** Whether the document has a spread to show; a single page has none. */
export function hasBookSpread(numPages: number): boolean {
  return numPages > 1
}

/**
 * The mode the viewer really lays out, which can outvote the reader's choice: a
 * one-page document has no spread, and book view would leave that page in the
 * left half of a double-width column (see `pairPages`). The choice itself is
 * left standing, so inserting a page brings book view back.
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

/**
 * Groups page numbers into book-view rows: 1-2, 3-4, and so on. A trailing odd
 * page keeps the left slot of its own row, so it stays the same size as the
 * pages above it instead of stretching across the whole spread.
 */
export function pairPages(numPages: number): number[][] {
  const rows: number[][] = []

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 2) {
    rows.push(spreadPages(pageNumber, numPages))
  }

  return rows
}

/**
 * The pages laid out beside `pageNumber`, itself included — the row `pairPages`
 * puts it in, which is what the reader of a spread actually has in front of
 * them. A trailing odd page stands alone.
 */
export function spreadPages(pageNumber: number, numPages: number): number[] {
  const first = pageNumber % 2 === 1 ? pageNumber : pageNumber - 1

  return first === numPages ? [first] : [first, first + 1]
}

/**
 * Thumbnails per row: as many as `containerWidth` fits, rounded down to an even
 * count so a row never splits a spread, and never fewer than two.
 */
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
