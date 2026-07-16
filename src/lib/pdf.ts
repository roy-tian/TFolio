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

/**
 * The page nearest `readingLine`, or null when nothing is visible. A page
 * spanning the line has distance 0. Ties resolve to the lowest page number, so
 * a book spread reports its left page and a thumbnail row its leftmost cell,
 * regardless of the order in which the pages became visible.
 */
export function pickNearestPage(
  candidates: PageCandidate[],
  readingLine: number,
): number | null {
  let nearestPage: number | null = null
  let nearestDistance = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const distance =
      readingLine >= candidate.top && readingLine <= candidate.bottom
        ? 0
        : Math.min(
            Math.abs(readingLine - candidate.top),
            Math.abs(readingLine - candidate.bottom),
          )

    // Comparing the page number on a tie makes the result independent of the
    // order the pages arrived in, without sorting on every scroll frame.
    if (
      distance < nearestDistance ||
      (distance === nearestDistance &&
        nearestPage !== null &&
        candidate.pageNumber < nearestPage)
    ) {
      nearestDistance = distance
      nearestPage = candidate.pageNumber
    }
  }

  return nearestPage
}
