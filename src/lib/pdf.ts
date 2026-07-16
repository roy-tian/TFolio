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
}

export const MAX_PDF_BYTES = 512 * 1024 * 1024

/** Widest a single page may render on screen, in CSS pixels. */
export const MAX_PAGE_WIDTH = 896

// Ceilings for a render request, mirroring MAX_RENDER_WIDTH and
// MAX_THUMBNAIL_WIDTH in src-tauri/src/pdfium.rs; the backend rejects wider.
export const MAX_RENDER_WIDTH = 4096
export const MAX_THUMBNAIL_RENDER_WIDTH = 512

// Floor for a page's render target, so a page squeezed into a narrow column
// still resolves well enough to read once the window widens again.
export const MIN_PAGE_RENDER_WIDTH = 240

export function isPdfFile(file: Pick<File, "name" | "type">) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
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

export type PageCandidate = {
  bottom: number
  pageNumber: number
  top: number
}

// How much of itself a page has to show before it claims the reader from a page
// above it. Half keeps the topmost page current until it is mostly gone.
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
