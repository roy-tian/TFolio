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

export type PdfSearchRect = {
  height: number
  left: number
  top: number
  width: number
}

/** One occurrence in document order. A phrase wrapped across lines remains one
    result and carries one highlight rectangle for each line it touches. */
export type PdfSearchMatch = {
  pageNumber: number
  rects: PdfSearchRect[]
}

export type PdfSearchOutcome = {
  cancelled: boolean
  limitReached: boolean
  matches: PdfSearchMatch[]
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

/** Whether the export landed on the document's own file: that, not the
    operation's name, is what decides the history counts as saved. */
export type PdfExportOutcome = {
  path: string
  savedToSource: boolean
}

/** Nothing here is patched into place: the page list and outline are
    replaced wholesale, the backend's document being the only truth. */
export type PdfStructureUpdate = {
  /** Whether a page another file brought in is still in the document, which
      leaves it export-only; the backend answers, it being what `save_pdf` refuses. */
  hasMergedPages: boolean
  numPages: number
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
}

/** `pageCount` is the one thing the frontend cannot know until the backend
    has read the file; it is what the insert's undo takes out again. */
export type PdfInsertOutcome = {
  pageCount: number
  update: PdfStructureUpdate
}

/** Widest a single page may render on screen, in CSS pixels. */
export const MAX_PAGE_WIDTH = 896

// Mirrors MIN_RENDER_WIDTH, MAX_RENDER_WIDTH and MAX_THUMBNAIL_WIDTH in
// src-tauri/src/pdfium/engine.rs; the backend rejects anything outside them.
export const MIN_RENDER_WIDTH = 64
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

/** Splits on both separators, so a Windows path reads as its file rather
    than the whole path. */
export function fileNameFromPath(path: string) {
  return path.split(/[/\\]/).pop() || path
}

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
 * PDFium's ordinary anti-aliasing reads visibly soft at one backing pixel
 * per CSS pixel, so low-DPI surfaces supersample to this instead of 2x.
 */
export const MIN_PAGE_OUTPUT_SCALE = 1.25

/** Capped at 2, the renderer's upper bound; a zero or absent `dpr` falls
    back to 1, since a zero ratio never means "no pixels". */
export function resolveOutputScale(dpr: number, minOutputScale = 1) {
  return Math.min(Math.max(dpr || 1, minOutputScale), 2)
}

export type PageCandidate = {
  bottom: number
  pageNumber: number
  top: number
}

// Half is load-bearing: two stacked pages can never both clear it, so the
// rule collapses to "whichever shows most" — where Chrome and pdf.js land.
const MIN_CURRENT_PAGE_VISIBILITY = 0.5

/** Measured against the most the viewport could ever show, not the page's
    own height, so tall pages and short rows reach the same scale. */
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
 * Not a fixed line down the viewport: a line deep enough to sit inside a
 * full page falls past a short row, handing the reader the row below.
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
