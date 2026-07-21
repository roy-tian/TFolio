import { useRef } from "react"
import { FilePlus, FileText, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { FileCard } from "@/components/FileCard"
import { PdfPage } from "@/components/PdfPage"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { useFileCardDrag } from "@/hooks/useFileCardDrag"
import { usePageDrag, type PageDragState } from "@/hooks/usePageDrag"
import type { RectDraft } from "@/hooks/useRectTool"
import type { RenderEpochs } from "@/lib/annotations"
import {
  fileCardOrderToPageOrder,
  type FileRange,
} from "@/lib/fileRanges"
import { type PdfPageInfo } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import {
  computeFileCardColumns,
  computeThumbnailColumns,
  FILE_CARD_GAP,
  FILE_CARD_WIDTH,
  pairPages,
  THUMBNAIL_GAP,
  THUMBNAIL_WIDTH,
  type ViewMode,
} from "@/lib/viewMode"
import { BOOK_GAP, CONTENT_PADDING_X } from "@/lib/zoom"

/** Everything the thumbnail grid's page editing needs from its owner. */
export type PageEditProps = {
  onDeletePage: (pageNumber: number) => void
  onInsertBlankPage: (index: number) => void
  /** Double-click: leave the grid for the page itself. */
  onOpenPage: (pageNumber: number) => void
  onReorderPages: (order: number[]) => void
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  selectedPages: ReadonlySet<number>
}

/** Everything the multi-file view needs from its owner. */
export type FilesEditProps = {
  /** The files as page ranges, derived from history by the owner. */
  ranges: FileRange[]
  onAddFile: () => void
  onDeleteFile: (range: FileRange) => void
  /** A full-document page permutation, the same seam page editing reorders by. */
  onReorderPages: (order: number[]) => void
}

type LayoutProps = {
  /** Width left for pages once the column's padding is taken out. */
  contentWidth: number
  documentId: number
  /** The rectangle being dragged out, on whichever page it started. */
  draft?: RectDraft
  pages: PdfPageInfo[]
  /** The document's usual page width at 100%, for a layout sharing one column. */
  referencePageWidth: number
  /** How many times each page has been drawn on, keyed by page number. */
  renderEpochs: RenderEpochs
  rotation: number
  /** Resolved zoom; the fit modes have already been worked out against it. */
  scale: number
  /** How many times each page's extracted text has changed. */
  textEpochs: RenderEpochs
}

function SingleLayout({
  documentId,
  draft,
  pages,
  renderEpochs,
  rotation,
  scale,
  textEpochs,
}: LayoutProps) {
  return pages.map((page, index) => (
    <PdfPage
      documentId={documentId}
      draft={draft?.pageNumber === index + 1 ? draft : undefined}
      key={`${documentId}-${index + 1}`}
      page={page}
      pageNumber={index + 1}
      renderEpoch={renderEpochs[index + 1] ?? 0}
      rotation={rotation}
      scale={scale}
      textEpoch={textEpochs[index + 1] ?? 0}
    />
  ))
}

function BookLayout({
  documentId,
  draft,
  pages,
  referencePageWidth,
  renderEpochs,
  rotation,
  scale,
  textEpochs,
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
          draft={draft?.pageNumber === pageNumber ? draft : undefined}
          key={`${documentId}-${pageNumber}`}
          page={pages[pageNumber - 1]}
          pageNumber={pageNumber}
          renderEpoch={renderEpochs[pageNumber] ?? 0}
          rotation={rotation}
          scale={scale}
          textEpoch={textEpochs[pageNumber] ?? 0}
          width={columnWidth}
        />
      ))}
    </div>
  ))
}

/**
 * The gap beside a thumbnail, as a button: hovering or focusing it shows a
 * dashed insertion line, clicking inserts a blank page there. During a drag
 * the same line, solid, marks where the drop would land — and the button goes
 * inert so the gesture above it keeps the pointer.
 */
function InsertZone({
  active,
  dragging,
  index,
  label,
  onInsert,
  trailing,
}: {
  /** Whether a drag in progress would drop into this gap. */
  active: boolean
  dragging: boolean
  /** The 1-based position a page inserted here would take. */
  index: number
  label: string
  onInsert: (index: number) => void
  trailing?: boolean
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "group/zone absolute top-0 z-10 flex h-full w-5 justify-center outline-none",
        trailing ? "-right-2.5" : "-left-2.5",
        dragging && "pointer-events-none",
      )}
      onClick={() => onInsert(index)}
      // A press in the gap is not the start of a page drag.
      onPointerDown={(event) => event.stopPropagation()}
      title={label}
      type="button"
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 w-0 border-l-2 border-dashed border-primary opacity-0 transition-opacity",
          !dragging && "group-hover/zone:opacity-100 group-focus-visible/zone:opacity-100",
          active && "border-solid opacity-100",
        )}
      />
      <span
        className={cn(
          "pointer-events-none absolute -top-2 grid size-5 place-items-center rounded-full border border-primary bg-background text-primary opacity-0 shadow-sm transition-opacity",
          !dragging && "group-hover/zone:opacity-100 group-focus-visible/zone:opacity-100",
          active && "opacity-100",
        )}
      >
        <Plus className="size-3" />
      </span>
    </button>
  )
}

/** The card riding the pointer during a drag: how many pages are in hand. */
function DragGhost({ drag }: { drag: PageDragState }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full"
      style={{ left: drag.pointer.x, top: drag.pointer.y - 8 }}
    >
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-2.5 py-1.5 shadow-lg">
        <FileText className="size-4 text-muted-foreground" />
        <span className="font-mono text-xs font-semibold tabular-nums">
          {drag.pages.length}
        </span>
      </div>
    </div>
  )
}

function ThumbnailLayout({
  contentWidth,
  currentPage,
  documentId,
  pageEdit,
  pages,
  renderEpochs,
  rotation,
}: LayoutProps & {
  currentPage: number
  pageEdit: PageEditProps
}) {
  const { t } = useTranslation()
  const columns = computeThumbnailColumns(contentWidth)
  const gridRef = useRef<HTMLDivElement>(null)
  const { drag, wasDragClick } = usePageDrag({
    active: true,
    columns,
    gridRef,
    onReorder: pageEdit.onReorderPages,
    pageCount: pages.length,
    selectedPages: pageEdit.selectedPages,
  })

  const selectPage = (pageNumber: number, modifiers: SelectionModifiers) => {
    // The click a finished drag releases is the gesture ending, not a choice.
    if (wasDragClick()) {
      return
    }

    pageEdit.onSelectPage(pageNumber, modifiers)
  }

  return (
    <div
      className="grid"
      ref={gridRef}
      style={{
        gap: THUMBNAIL_GAP,
        gridTemplateColumns: `repeat(${columns}, ${THUMBNAIL_WIDTH}px)`,
      }}
    >
      {pages.map((page, index) => {
        const pageNumber = index + 1

        return (
          <div className="relative" key={`${documentId}-${pageNumber}`}>
            <PdfThumbnail
              deleteDisabled={
                pages.length === 1 ||
                // Deleting a selected page takes the whole selection; when that
                // is every page the backend refuses it, so the button that
                // would silently do nothing is disabled instead.
                (pageEdit.selectedPages.has(pageNumber) &&
                  pageEdit.selectedPages.size === pages.length)
              }
              documentId={documentId}
              isCurrent={currentPage === pageNumber}
              isSelected={pageEdit.selectedPages.has(pageNumber)}
              onDelete={pageEdit.onDeletePage}
              onOpen={pageEdit.onOpenPage}
              onSelect={selectPage}
              page={page}
              pageNumber={pageNumber}
              renderEpoch={renderEpochs[pageNumber] ?? 0}
              rotation={rotation}
              selectedCount={pageEdit.selectedPages.size}
              width={THUMBNAIL_WIDTH}
            />
            <InsertZone
              active={drag?.gap === pageNumber - 1}
              dragging={Boolean(drag)}
              index={pageNumber}
              label={t("pageEdit.insertBefore", { pageNumber })}
              onInsert={pageEdit.onInsertBlankPage}
            />
            {pageNumber === pages.length ? (
              <InsertZone
                active={drag?.gap === pageNumber}
                dragging={Boolean(drag)}
                index={pageNumber + 1}
                label={t("pageEdit.insertAtEnd")}
                onInsert={pageEdit.onInsertBlankPage}
                trailing
              />
            ) : null}
          </div>
        )
      })}
      {drag ? <DragGhost drag={drag} /> : null}
    </div>
  )
}

/** The card riding the pointer during a file-card drag. */
function FileDragGhost({
  name,
  pointer,
}: {
  name: string
  pointer: { x: number; y: number }
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full"
      style={{ left: pointer.x, top: pointer.y - 8 }}
    >
      <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/90 px-2.5 py-1.5 shadow-lg">
        <FileText className="size-4 text-muted-foreground" />
        <span className="max-w-40 truncate text-xs font-medium">{name}</span>
      </div>
    </div>
  )
}

function FilesLayout({
  contentWidth,
  documentId,
  filesEdit,
  pages,
  renderEpochs,
  rotation,
}: LayoutProps & { filesEdit: FilesEditProps }) {
  const { t } = useTranslation()
  const { ranges } = filesEdit
  const columns = computeFileCardColumns(contentWidth)
  const gridRef = useRef<HTMLDivElement>(null)
  const { drag } = useFileCardDrag({
    active: true,
    cardCount: ranges.length,
    columns,
    gridRef,
    onReorder: (cardOrder) =>
      filesEdit.onReorderPages(
        fileCardOrderToPageOrder(ranges, cardOrder, pages.length),
      ),
  })
  const draggedName =
    drag && ranges[drag.cardPosition - 1]
      ? ranges[drag.cardPosition - 1]!.name
      : ""

  return (
    <div
      className="grid"
      ref={gridRef}
      style={{
        gap: FILE_CARD_GAP,
        gridTemplateColumns: `repeat(${columns}, ${FILE_CARD_WIDTH}px)`,
      }}
    >
      {ranges.map((range, index) => {
        // The face is the file's first real page, not its first slot: a pad
        // moved to the run's front must not become the card's thumbnail.
        const page = pages[range.firstReal - 1]

        // A structure change updates the page list and the history in two steps;
        // for the render between them, a range may point past the pages it has.
        if (!page) {
          return null
        }

        return (
          <div
            className={cn(
              "transition-opacity",
              drag?.cardPosition === index + 1 && "opacity-40",
            )}
            // A page-level move can split one file into two runs of the same id;
            // the start disambiguates them so the two cards never share a key.
            key={`${documentId}-${range.id}-${range.start}`}
          >
            <FileCard
              deleteDisabled={ranges.length === 1}
              documentId={documentId}
              onDelete={filesEdit.onDeleteFile}
              page={page}
              position={index + 1}
              range={range}
              renderEpoch={renderEpochs[range.firstReal] ?? 0}
              rotation={rotation}
              width={FILE_CARD_WIDTH}
            />
          </div>
        )
      })}
      {/* A keyboard- and no-drag-reachable way to merge a file, and the seam the
          e2e suite drives (WebDriver cannot drop files). */}
      <button
        className="flex flex-col items-center justify-center gap-2 self-start rounded-md border border-dashed border-zinc-400 px-3 text-center text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-slot="add-file"
        onClick={filesEdit.onAddFile}
        style={{ aspectRatio: FILE_CARD_WIDTH / (FILE_CARD_WIDTH * 1.3) }}
        title={t("files.addFile")}
        type="button"
      >
        <FilePlus className="size-6" />
        <span className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium">{t("files.addFile")}</span>
          <span className="text-xs font-normal text-balance text-muted-foreground/75">
            {t("files.addFileHint")}
          </span>
        </span>
      </button>
      {drag ? <FileDragGhost name={draggedName} pointer={drag.pointer} /> : null}
    </div>
  )
}

type PdfViewerLayoutProps = {
  currentPage: number
  documentId: number
  draft?: RectDraft
  fileName: string
  filesEdit: FilesEditProps
  pageEdit: PageEditProps
  pages: PdfPageInfo[]
  referencePageWidth: number
  renderEpochs: RenderEpochs
  rotation: number
  scale: number
  textEpochs: RenderEpochs
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
  draft,
  fileName,
  filesEdit,
  pageEdit,
  pages,
  referencePageWidth,
  renderEpochs,
  rotation,
  scale,
  textEpochs,
  viewMode,
  viewerWidth,
}: PdfViewerLayoutProps) {
  const contentWidth = Math.max(0, viewerWidth - CONTENT_PADDING_X)
  const layoutProps = {
    contentWidth,
    documentId,
    draft,
    pages,
    referencePageWidth,
    renderEpochs,
    rotation,
    scale,
    textEpochs,
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
          pageEdit={pageEdit}
        />
      ) : viewMode === "files" ? (
        <FilesLayout {...layoutProps} filesEdit={filesEdit} />
      ) : (
        <SingleLayout {...layoutProps} />
      )}
    </div>
  )
}
