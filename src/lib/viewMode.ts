import { readStored, store } from "@/lib/storage"

export const viewModes = ["single", "book", "thumbnail", "files"] as const

export type ViewMode = (typeof viewModes)[number]

export const defaultViewMode: ViewMode = "single"
export const viewModeStorageKey = "tfolio.ui.viewMode"

/** Width of one thumbnail cell, and the gap between cells, in CSS pixels. */
export const THUMBNAIL_WIDTH = 160
export const THUMBNAIL_GAP = 16

/** Width of one file card's face, and the gap between cards, in CSS pixels. The
    gap is wide enough to hold the leaves a multi-page card fans out behind it. */
export const FILE_CARD_WIDTH = 176
export const FILE_CARD_GAP = 40

/** Columns of `columnWidth` with `gap` between them that fit `containerWidth`.
    `n` columns occupy `n * columnWidth + (n - 1) * gap`, so lending the row one
    extra gap makes the fit a plain division. */
function columnsThatFit(
  containerWidth: number,
  columnWidth: number,
  gap: number,
): number {
  return Math.floor((containerWidth + gap) / (columnWidth + gap))
}

/** File cards per row: as many as `containerWidth` fits, and never fewer than
    one — unlike thumbnails, a row of cards need not stay even. */
export function computeFileCardColumns(
  containerWidth: number,
  columnWidth = FILE_CARD_WIDTH,
  gap = FILE_CARD_GAP,
): number {
  return Math.max(1, columnsThatFit(containerWidth, columnWidth, gap))
}

export function isViewMode(value: unknown): value is ViewMode {
  return viewModes.includes(value as ViewMode)
}

export function readStoredViewMode(): ViewMode | null {
  return readStored(viewModeStorageKey, isViewMode)
}

export function storeViewMode(mode: ViewMode) {
  store(viewModeStorageKey, mode)
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
  const fit = columnsThatFit(containerWidth, columnWidth, gap)

  return Math.max(2, Math.floor(fit / 2) * 2)
}
