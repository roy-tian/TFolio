export const viewModes = ["single", "book", "thumbnail"] as const

export type ViewMode = (typeof viewModes)[number]

export const defaultViewMode: ViewMode = "single"
export const viewModeStorageKey = "tfolio.ui.viewMode"

/** Width of one thumbnail cell, and the gap between cells, in CSS pixels. */
export const THUMBNAIL_WIDTH = 160
export const THUMBNAIL_GAP = 16

export function isViewMode(value: unknown): value is ViewMode {
  return viewModes.includes(value as ViewMode)
}

export function readStoredViewMode(): ViewMode | null {
  try {
    const stored = window.localStorage.getItem(viewModeStorageKey)
    return isViewMode(stored) ? stored : null
  } catch {
    return null
  }
}

export function storeViewMode(mode: ViewMode) {
  try {
    window.localStorage.setItem(viewModeStorageKey, mode)
  } catch {
    // A restricted WebView can disable storage. The active session still works.
  }
}

/**
 * Groups page numbers into book-view rows: 1-2, 3-4, and so on. A trailing odd
 * page keeps the left slot of its own row, so it stays the same size as the
 * pages above it instead of stretching across the whole spread.
 */
export function pairPages(numPages: number): number[][] {
  const rows: number[][] = []

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 2) {
    rows.push(
      pageNumber === numPages ? [pageNumber] : [pageNumber, pageNumber + 1],
    )
  }

  return rows
}

/**
 * Thumbnails per row: as many as `containerWidth` fits, rounded down to an even
 * count so a row never splits a spread, and never fewer than two.
 */
export function computeThumbnailColumns(
  containerWidth: number,
  columnWidth = THUMBNAIL_WIDTH,
  gap = THUMBNAIL_GAP,
): number {
  // `n` columns occupy n * columnWidth + (n - 1) * gap, so lending the row one
  // extra gap makes the fit a plain division.
  const fit = Math.floor((containerWidth + gap) / (columnWidth + gap))

  return Math.max(2, Math.floor(fit / 2) * 2)
}
