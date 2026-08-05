export type PdfOutlineItem = {
  items: PdfOutlineItem[]
  pageNumber: number | null
  title: string
}

export type PdfPageInfo = {
  height: number
  // Clockwise rotation in degrees (0/90/180/270). `width`/`height` are the
  // displayed dimensions with this rotation already applied.
  rotation: number
  width: number
}

/**
 * A run of text on a page and its bounding box, in PDF points with a top-left
 * origin. Used to overlay a selectable text layer on the rendered page image.
 */
export type PdfTextSpan = {
  height: number
  left: number
  text: string
  top: number
  width: number
}

export type PdfDocumentInfo = {
  id: number
  numPages: number
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
  /** The file this document was opened from; null when opened from bytes,
      which leaves nothing to save over. */
  path: string | null
}

/** What an export wrote, and whether it landed on the document's own file —
    which, not the operation's name, is what decides the history counts as
    saved. */
export type PdfExportOutcome = {
  path: string
  savedToSource: boolean
}

/** Fresh metadata after a page-structure change. Nothing here is patched into
    place: the page list and outline are replaced wholesale, because the
    backend's document is the only truth about what the pages now are. */
export type PdfStructureUpdate = {
  numPages: number
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
}

/** What a merge appended. `pageCount` is the one thing the frontend cannot
    derive from history until the backend has read the file, so the merge
    command carries it back from here. */
export type PdfMergeOutcome = {
  insertedAt: number
  pageCount: number
  update: PdfStructureUpdate
}

/** Widest a single page may render on screen, in CSS pixels. */
export const MAX_PAGE_WIDTH = 896

// Ceilings for a render request, mirroring MAX_RENDER_WIDTH and
// MAX_THUMBNAIL_WIDTH in src-tauri/src/pdfium.rs; the backend rejects wider.
export const MAX_RENDER_WIDTH = 4096
export const MAX_THUMBNAIL_RENDER_WIDTH = 512

// Floor for a page's render target, so a page squeezed into a narrow column
// still resolves well enough to read once the window widens again.
export const MIN_PAGE_RENDER_WIDTH = 240

/** Judged by the name alone: a path has no MIME type to consult, and the
    backend rejects anything PDFium cannot actually parse. */
export function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf")
}

/** The name a path ends in, for display. Splits on both separators so a
    Windows path reads as its file rather than the whole path. */
export function fileNameFromPath(path: string) {
  return path.split(/[/\\]/).pop() || path
}

// Rotating a page by 90° or 270° swaps its width and height; 0°/180° leave them.
export function dimensionsForRotation(
  rotation: number,
  width: number,
  height: number,
) {
  return rotation === 90 || rotation === 270
    ? { height: width, width: height }
    : { height, width }
}

/**
 * Minimum backing pixels per CSS pixel for a settled page bitmap. PDFium's
 * ordinary grayscale anti-aliasing reads as visibly soft when a display gives
 * the page just one backing pixel per CSS pixel, so the viewer raises the
 * render-resolution floor from 1x to this modest 1.25x instead of paying for a
 * heavier 2x supersample. Only surfaces whose `devicePixelRatio` is below 1.25
 * are affected; a higher-DPI display already reaches the shared 2x ceiling.
 */
export const MIN_PAGE_OUTPUT_SCALE = 1.25

/**
 * Backing pixels to render per CSS pixel, floored at `minOutputScale` (so a
 * low-DPI surface still supersamples) and capped at 2 (the renderer's upper
 * bound). A zero or absent `dpr` falls back to 1, since a zero ratio never
 * means "no pixels".
 */
export function resolveOutputScale(dpr: number, minOutputScale = 1) {
  return Math.min(Math.max(dpr || 1, minOutputScale), 2)
}

export type PageCandidate = {
  bottom: number
  pageNumber: number
  top: number
}

// How much of itself a page has to show to claim the reader from the page above.
// Half is load-bearing: two stacked pages can never both clear it, so exactly one
// qualifies and the rule collapses to "whichever shows most" — where Chrome and
// pdf.js land. Lower it and the tie holds the page above current far too long.
const MIN_CURRENT_PAGE_VISIBILITY = 0.5

/**
 * How much of `candidate` the viewport shows, against the most it could ever
 * show. Measuring against the viewport rather than the page's own height keeps
 * the score scale free: a page taller than the viewport reaches 1 by filling
 * it, exactly as a short thumbnail row reaches 1 by fitting inside it.
 */
function visibleFraction(
  candidate: PageCandidate,
  viewportTop: number,
  viewportBottom: number,
) {
  const height = candidate.bottom - candidate.top
  const viewportHeight = viewportBottom - viewportTop

  if (height <= 0 || viewportHeight <= 0) {
    return 0
  }

  const visible =
    Math.min(candidate.bottom, viewportBottom) -
    Math.max(candidate.top, viewportTop)

  return Math.max(0, visible) / Math.min(height, viewportHeight)
}

/**
 * The page the reader is on, or null when nothing is visible: the first page
 * showing at least half of what it could, else whichever shows the most.
 *
 * Deliberately not a fixed line down the viewport. Navigation parks a page at
 * the top of the viewer, so any line deep enough to sit inside a full page
 * would fall past a short one — a thumbnail row, or a wide page in a book
 * spread — and hand the reader the row below the one they asked for. Judging a
 * page by how much of it shows holds for every row height.
 *
 * Ties resolve to the lowest page number, so a book spread reports its left
 * page and a thumbnail row its leftmost cell, whatever order they arrived in.
 */
export function pickCurrentPage(
  candidates: PageCandidate[],
  viewportTop: number,
  viewportBottom: number,
): number | null {
  let currentPage: number | null = null
  // A gap between two tall pages can leave both just under the bar, so keep the
  // most visible page as a fallback rather than reporting nothing.
  let fallbackPage: number | null = null
  let fallbackFraction = -1

  for (const candidate of candidates) {
    const fraction = visibleFraction(candidate, viewportTop, viewportBottom)

    if (fraction >= MIN_CURRENT_PAGE_VISIBILITY) {
      if (currentPage === null || candidate.pageNumber < currentPage) {
        currentPage = candidate.pageNumber
      }
    } else if (
      fraction > fallbackFraction ||
      (fraction === fallbackFraction &&
        fallbackPage !== null &&
        candidate.pageNumber < fallbackPage)
    ) {
      fallbackFraction = fraction
      fallbackPage = candidate.pageNumber
    }
  }

  return currentPage ?? fallbackPage
}
