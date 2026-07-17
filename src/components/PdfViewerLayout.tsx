import { PdfPage } from "@/components/PdfPage"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import type { RenderEpochs } from "@/lib/annotations"
import { type PdfPageInfo } from "@/lib/pdf"
import {
  computeThumbnailColumns,
  pairPages,
  THUMBNAIL_GAP,
  THUMBNAIL_WIDTH,
  type ViewMode,
} from "@/lib/viewMode"
import { BOOK_GAP, CONTENT_PADDING_X } from "@/lib/zoom"

type LayoutProps = {
  /** Width left for pages once the column's padding is taken out. */
  contentWidth: number
  documentId: number
  pages: PdfPageInfo[]
  /** The document's usual page width at 100%, for a layout sharing one column. */
  referencePageWidth: number
  /** How many times each page has been drawn on, keyed by page number. */
  renderEpochs: RenderEpochs
  rotation: number
  /** Resolved zoom; the fit modes have already been worked out against it. */
  scale: number
}

function SingleLayout({
  documentId,
  pages,
  renderEpochs,
  rotation,
  scale,
}: LayoutProps) {
  return pages.map((page, index) => (
    <PdfPage
      documentId={documentId}
      key={`${documentId}-${index + 1}`}
      page={page}
      pageNumber={index + 1}
      renderEpoch={renderEpochs[index + 1] ?? 0}
      rotation={rotation}
      scale={scale}
    />
  ))
}

function BookLayout({
  documentId,
  pages,
  referencePageWidth,
  renderEpochs,
  rotation,
  scale,
}: LayoutProps) {
  // Both halves of a spread share one width: two columns of visibly different
  // widths would read as broken, where a single column simply following each
  // page's own size does not. A trailing odd page keeps the left cell and stays
  // this size rather than stretching across the spread.
  const columnWidth = Math.round(referencePageWidth * scale)

  return pairPages(pages.length).map((row) => (
    <div
      className="flex items-start"
      key={`${documentId}-spread-${row[0]}`}
      // Sized for a full spread even when holding a single trailing page, which
      // keeps that page in the left cell instead of centring it in the column.
      style={{ gap: BOOK_GAP, width: columnWidth * 2 + BOOK_GAP }}
    >
      {row.map((pageNumber) => (
        <PdfPage
          documentId={documentId}
          key={`${documentId}-${pageNumber}`}
          page={pages[pageNumber - 1]}
          pageNumber={pageNumber}
          renderEpoch={renderEpochs[pageNumber] ?? 0}
          rotation={rotation}
          scale={scale}
          width={columnWidth}
        />
      ))}
    </div>
  ))
}

function ThumbnailLayout({
  contentWidth,
  currentPage,
  documentId,
  onSelectThumbnail,
  pages,
  renderEpochs,
  rotation,
}: LayoutProps & {
  currentPage: number
  onSelectThumbnail: (pageNumber: number) => void
}) {
  const columns = computeThumbnailColumns(contentWidth)

  return (
    <div
      className="grid"
      style={{
        gap: THUMBNAIL_GAP,
        gridTemplateColumns: `repeat(${columns}, ${THUMBNAIL_WIDTH}px)`,
      }}
    >
      {pages.map((page, index) => (
        <PdfThumbnail
          documentId={documentId}
          isCurrent={currentPage === index + 1}
          key={`${documentId}-${index + 1}`}
          onSelect={onSelectThumbnail}
          page={page}
          pageNumber={index + 1}
          renderEpoch={renderEpochs[index + 1] ?? 0}
          rotation={rotation}
          width={THUMBNAIL_WIDTH}
        />
      ))}
    </div>
  )
}

type PdfViewerLayoutProps = {
  currentPage: number
  documentId: number
  fileName: string
  onSelectThumbnail: (pageNumber: number) => void
  pages: PdfPageInfo[]
  referencePageWidth: number
  renderEpochs: RenderEpochs
  rotation: number
  scale: number
  viewMode: ViewMode
  viewerWidth: number
}

/**
 * Arranges a document's pages for the active view mode. Every mode tags its
 * pages with `data-page-number`, which is what lets page tracking, the page
 * input, and bookmark navigation stay layout agnostic.
 */
export function PdfViewerLayout({
  currentPage,
  documentId,
  fileName,
  onSelectThumbnail,
  pages,
  referencePageWidth,
  renderEpochs,
  rotation,
  scale,
  viewMode,
  viewerWidth,
}: PdfViewerLayoutProps) {
  const contentWidth = Math.max(0, viewerWidth - CONTENT_PADDING_X)
  const layoutProps = {
    contentWidth,
    documentId,
    pages,
    referencePageWidth,
    renderEpochs,
    rotation,
    scale,
  }

  return (
    <div
      aria-label={fileName}
      // `min-w-fit` is what keeps a zoomed-in page reachable. Without it this
      // box would only ever be as wide as the viewer, and `items-center` would
      // centre an overflowing page by splitting the overflow across both sides
      // — where the left half sits at a negative offset the viewer cannot
      // scroll back to. Growing the box instead turns that into ordinary
      // scrollable width. It costs nothing while the pages still fit.
      className="flex min-h-full min-w-fit flex-col items-center gap-5 px-8 py-8"
    >
      {viewMode === "book" ? (
        <BookLayout {...layoutProps} />
      ) : viewMode === "thumbnail" ? (
        <ThumbnailLayout
          {...layoutProps}
          currentPage={currentPage}
          onSelectThumbnail={onSelectThumbnail}
        />
      ) : (
        <SingleLayout {...layoutProps} />
      )}
    </div>
  )
}
