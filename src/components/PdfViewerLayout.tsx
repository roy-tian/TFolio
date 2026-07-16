import { PdfPage } from "@/components/PdfPage"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { MAX_PAGE_WIDTH, type PdfPageInfo } from "@/lib/pdf"
import {
  computeThumbnailColumns,
  pairPages,
  THUMBNAIL_GAP,
  THUMBNAIL_WIDTH,
  type ViewMode,
} from "@/lib/viewMode"

// Horizontal padding of the scrolling column (`px-8` on either side).
const CONTENT_PADDING = 64
// Space between the two pages of a spread. Applied inline rather than as a
// Tailwind class because the column arithmetic below has to agree with it.
const BOOK_GAP = 20

type LayoutProps = {
  /** Width left for pages once the column's padding is taken out. */
  contentWidth: number
  documentId: number
  pages: PdfPageInfo[]
  rotation: number
}

function SingleLayout({ contentWidth, documentId, pages, rotation }: LayoutProps) {
  const maxWidth = Math.min(MAX_PAGE_WIDTH, contentWidth)

  return pages.map((page, index) => (
    <PdfPage
      documentId={documentId}
      key={`${documentId}-${index + 1}`}
      maxWidth={maxWidth}
      page={page}
      pageNumber={index + 1}
      rotation={rotation}
    />
  ))
}

function BookLayout({ contentWidth, documentId, pages, rotation }: LayoutProps) {
  // Two pages plus the gap share the column, so each gets a little under half.
  // A trailing odd page keeps the left cell and stays this size rather than
  // stretching across the spread.
  const maxWidth = Math.max(
    0,
    Math.min(MAX_PAGE_WIDTH, Math.floor((contentWidth - BOOK_GAP) / 2)),
  )

  return pairPages(pages.length).map((row) => (
    <div
      className="grid w-full grid-cols-2 items-start"
      key={`${documentId}-spread-${row[0]}`}
      style={{ gap: BOOK_GAP, maxWidth: maxWidth * 2 + BOOK_GAP }}
    >
      {row.map((pageNumber) => (
        <PdfPage
          documentId={documentId}
          key={`${documentId}-${pageNumber}`}
          maxWidth={maxWidth}
          page={pages[pageNumber - 1]}
          pageNumber={pageNumber}
          rotation={rotation}
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
  rotation: number
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
  rotation,
  viewMode,
  viewerWidth,
}: PdfViewerLayoutProps) {
  const contentWidth = Math.max(0, viewerWidth - CONTENT_PADDING)
  const layoutProps = { contentWidth, documentId, pages, rotation }

  return (
    <div
      aria-label={fileName}
      className="flex min-h-full flex-col items-center gap-5 px-8 py-8"
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
