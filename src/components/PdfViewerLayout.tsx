import { useLayoutEffect, useRef, type RefObject } from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PdfPage } from "@/components/PdfPage"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { usePageDrag, type PageDragState } from "@/hooks/usePageDrag"
import type { RectDraft } from "@/hooks/useRectTool"
import type { RenderEpochs } from "@/lib/annotations"
import { orderAfterMove, slotOffsets, type CellBox } from "@/lib/pageDrag"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import {
  computeThumbnailColumns,
  pairPages,
  THUMBNAIL_COLUMN_GAP,
  THUMBNAIL_ROW_GAP,
  THUMBNAIL_WIDTH,
  type ViewMode,
} from "@/lib/viewMode"
import { BOOK_GAP, CONTENT_PADDING_X } from "@/lib/zoom"

// The wheel preview has already collapsed a gesture into one layout commit.
// Holding its bitmap resolution a little longer also coalesces rapid toolbar
// clicks and resize-driven fits without putting a timer in every page.
const RENDER_SETTLE_MS = 150

/** Everything the thumbnail grid's page editing needs from its owner. */
export type PageEditProps = {
  /** Where a PDF dragged in from the desktop would land: the 1-based position
      its first page would take, or null while nothing is being dragged over the
      grid. The owner reads the drop; the grid only draws where it points. */
  fileDropIndex: number | null
  onDeletePage: (pageNumber: number) => void
  onInsertBlankPage: (index: number) => void
  /** Double-click: leave the grid for the page itself. */
  onOpenPage: (pageNumber: number) => void
  /** Answers with the reorder's own promise, which the grid holds its
      make-way layout until: the pages change only once the backend has moved
      them. */
  onReorderPages: (order: number[]) => void | Promise<unknown>
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  selectedPages: ReadonlySet<number>
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
  renderScale: number
  rotation: number
  /** Resolved zoom; the fit modes have already been worked out against it. */
  scale: number
  /** How many times each page's extracted text has changed. */
  textEpochs: RenderEpochs
  /** Freeze the current heavy-page window during compositor-only zoom. */
  virtualizationPaused: boolean
  /** Preserve pages already crossed by an active text-selection drag. */
  virtualizationRetainExited: boolean
}

function SingleLayout({
  documentId,
  draft,
  pages,
  renderEpochs,
  renderScale,
  rotation,
  scale,
  textEpochs,
  virtualizationPaused,
  virtualizationRetainExited,
}: LayoutProps) {
  return pages.map((page, index) => (
    <PdfPage
      documentId={documentId}
      draft={draft?.pageNumber === index + 1 ? draft : undefined}
      key={`${documentId}-${index + 1}`}
      page={page}
      pageNumber={index + 1}
      renderEpoch={renderEpochs[index + 1] ?? 0}
      renderScale={renderScale}
      rotation={rotation}
      scale={scale}
      textEpoch={textEpochs[index + 1] ?? 0}
      virtualizationPaused={virtualizationPaused}
      virtualizationRetainExited={virtualizationRetainExited}
    />
  ))
}

function BookLayout({
  documentId,
  draft,
  pages,
  referencePageWidth,
  renderEpochs,
  renderScale,
  rotation,
  scale,
  textEpochs,
  virtualizationPaused,
  virtualizationRetainExited,
}: LayoutProps) {
  // Both halves of a spread share one width: two columns of visibly different
  // widths would read as broken, where a single column simply following each
  // page's own size does not. A trailing odd page keeps the left cell and stays
  // this size rather than stretching across the spread.
  const columnWidth = Math.round(referencePageWidth * scale)
  const renderColumnWidth = Math.round(referencePageWidth * renderScale)

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
          renderScale={renderScale}
          renderWidth={renderColumnWidth}
          rotation={rotation}
          scale={scale}
          textEpoch={textEpochs[pageNumber] ?? 0}
          virtualizationPaused={virtualizationPaused}
          virtualizationRetainExited={virtualizationRetainExited}
          width={columnWidth}
        />
      ))}
    </div>
  ))
}

/**
 * The gap beside a thumbnail, as a button: it fills the space between the two
 * pages, so hovering or focusing anywhere in there shows a dashed insertion line
 * down the middle of the gap, and pressing it inserts a blank page. The same
 * line, solid, marks where a PDF dragged in from the desktop would land — which
 * is why the zone carries its own position as `data-insert-index`, for the drop
 * to read off the element under the pointer. A page dragged *within* the grid
 * says it differently: the cells themselves move aside, so while that gesture
 * runs the zone shows nothing and goes inert, leaving it the pointer.
 */
function InsertZone({
  dragging,
  fileDropIndex,
  index,
  label,
  onInsert,
  paperHeight,
  trailing,
}: {
  /** Whether a page drag has the grid, which mutes every zone. */
  dragging: boolean
  /** The position a dropped file's first page would take, or null. */
  fileDropIndex: number | null
  /** The 1-based position a page inserted here would take. */
  index: number
  label: string
  onInsert: (index: number) => void
  /** The neighbouring page's own height in CSS pixels. The gap runs the full
      cell, which is taller — it also holds the page number and the row's own
      spacing — so the line is sized to the paper instead of stretched past it. */
  paperHeight: number
  trailing?: boolean
}) {
  const active = fileDropIndex === index

  return (
    <button
      aria-label={label}
      className={cn(
        "group/zone absolute top-0 z-10 flex h-full justify-center outline-none",
        dragging && "pointer-events-none",
      )}
      data-insert-index={index}
      onClick={() => onInsert(index)}
      // A press in the gap is not the start of a page drag.
      onPointerDown={(event) => event.stopPropagation()}
      // The whole gap, so every point over the grid names an insertion position
      // — the cells answer for themselves — and the line lands in its middle.
      style={{
        [trailing ? "right" : "left"]: -THUMBNAIL_COLUMN_GAP,
        width: THUMBNAIL_COLUMN_GAP,
      }}
      title={label}
      type="button"
    >
      <span
        className={cn(
          "pointer-events-none absolute top-0 w-0 border-l border-dashed border-primary/50 opacity-0 transition-opacity",
          !dragging && "group-hover/zone:opacity-100 group-focus-visible/zone:opacity-100",
          // A drop lands somewhere definite, so that line speaks up.
          active && "border-l-2 border-solid border-primary opacity-100",
        )}
        style={{ height: paperHeight }}
      />
      <span
        className={cn(
          "pointer-events-none absolute grid size-5 -translate-y-1/2 place-items-center rounded-full border border-primary bg-background text-primary opacity-0 shadow-sm transition-opacity",
          !dragging && "group-hover/zone:opacity-100 group-focus-visible/zone:opacity-100",
          active && "opacity-100",
        )}
        style={{ top: paperHeight / 2 }}
      >
        <Plus className="size-3" />
      </span>
    </button>
  )
}

/**
 * The page riding the pointer: the grabbed thumbnail itself, its pixels copied
 * straight out of the cell it was lifted from. The grid's canvas is a bitmap
 * the frontend already holds, so the ghost costs no second render and needs no
 * image source — the same reason page bitmaps never become `blob:` URLs. A
 * block of pages stacks two blank cards behind the one on top and counts
 * itself in the corner.
 *
 * It hangs off the pointer by the grip it was picked up by, so the paper stays
 * under the same spot of itself the whole way to the drop.
 */
function DragGhost({
  drag,
  gridRef,
  page,
  rotation,
}: {
  drag: PageDragState
  gridRef: RefObject<HTMLElement | null>
  /** The grabbed page, for the paper's own proportions. */
  page: PdfPageInfo
  rotation: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Every render, deliberately: the cell's own bitmap arrives asynchronously,
  // so a page grabbed the moment it scrolled into view has nothing to copy yet.
  // The drag re-renders on each move, which is when the pixels are picked up.
  useLayoutEffect(() => {
    const source = gridRef.current?.querySelector<HTMLCanvasElement>(
      `[data-page-number="${drag.lead}"] canvas`,
    )
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")

    if (!source || !canvas || !context) {
      return
    }

    // Assigning either dimension clears the canvas, so only on a real change.
    if (canvas.width !== source.width || canvas.height !== source.height) {
      canvas.width = source.width
      canvas.height = source.height
    }

    context.drawImage(source, 0, 0)
  })

  const footprint = dimensionsForRotation(rotation, page.width, page.height)
  const height = (THUMBNAIL_WIDTH * footprint.height) / footprint.width

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50"
      style={{
        height,
        left: drag.pointer.x + drag.grip.x,
        top: drag.pointer.y + drag.grip.y,
        width: THUMBNAIL_WIDTH,
      }}
    >
      {/* Two cards for a block of any size: the stack says "more than this
          one", the badge says how many. */}
      {drag.pages.length > 1
        ? [8, 4].map((step) => (
            <div
              className="absolute inset-0 bg-white opacity-70 shadow-md ring-1 ring-black/10"
              key={step}
              style={{
                transform: `translate(${step}px, ${step}px) rotate(${step / 2}deg)`,
              }}
            />
          ))
        : null}
      <div className="absolute inset-0 -rotate-2 overflow-hidden bg-white opacity-90 shadow-2xl ring-1 ring-black/10">
        <div
          className="absolute"
          style={{
            height: `${(page.height / footprint.height) * 100}%`,
            left: "50%",
            top: "50%",
            transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            width: `${(page.width / footprint.width) * 100}%`,
          }}
        >
          <canvas className="block h-full w-full" ref={canvasRef} />
        </div>
      </div>
      {drag.pages.length > 1 ? (
        <span className="absolute -right-2 -top-2 grid min-w-5 place-items-center rounded-full bg-primary px-1 py-0.5 font-mono text-xs font-semibold tabular-nums text-primary-foreground shadow-md">
          {drag.pages.length}
        </span>
      ) : null}
    </div>
  )
}

/**
 * What the grid shows while a drag hovers a gap: the pages in hand, where every
 * other page slides to make room for them, and the slot the block would land
 * in. Read straight from the drag, so the preview and the drop that follows it
 * are the same arithmetic.
 *
 * Letting go changes none of it. The pages have not moved yet — the backend
 * has still to be asked — so the way stays made and the hole stays open, held
 * for the pages the ghost was carrying, until the reorder lands and the grid
 * really holds what this was drawing.
 */
function dropPreview(
  drag: PageDragState,
  pageCount: number,
): {
  landing: CellBox | undefined
  lifted: ReadonlySet<number>
  offsets: Map<number, { x: number; y: number }>
} {
  const order = orderAfterMove(drag.pages, drag.gap, pageCount)
  const lifted = new Set(drag.pages)

  return {
    // The block keeps its order, so its first page is where it starts.
    landing: drag.cells[order.indexOf(drag.pages[0]!)],
    lifted,
    offsets: slotOffsets(order, drag.cells, lifted),
  }
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

  const preview = drag ? dropPreview(drag, pages.length) : null
  const ghostPage = drag ? pages[drag.lead - 1] : undefined

  const selectPage = (pageNumber: number, modifiers: SelectionModifiers) => {
    // The click a finished drag releases is the gesture ending, not a choice.
    if (wasDragClick()) {
      return
    }

    pageEdit.onSelectPage(pageNumber, modifiers)
  }

  return (
    <div
      className="relative grid"
      ref={gridRef}
      // The row gap is the cell's own bottom padding rather than the grid's, so
      // that every point between two rows still belongs to a cell: a file drag
      // crossing it must keep naming a position, not fall through to the
      // workspace's open-as-a-tab target for the height of the gap.
      style={{
        columnGap: THUMBNAIL_COLUMN_GAP,
        gridTemplateColumns: `repeat(${columns}, ${THUMBNAIL_WIDTH}px)`,
        rowGap: 0,
      }}
    >
      {/* The hole the block would drop into, drawn before the cells so a page
          sliding past it passes over it rather than under. */}
      {preview?.landing ? (
        <div
          aria-hidden
          className="pointer-events-none absolute border-2 border-dashed border-primary/60 bg-primary/5 transition-all duration-200 ease-out"
          style={{
            height: preview.landing.height,
            left: preview.landing.left,
            top: preview.landing.top,
            width: preview.landing.width,
          }}
        />
      ) : null}
      {pages.map((page, index) => {
        const pageNumber = index + 1
        // Where this page stands while the drag hovers: aside, to open the
        // hole, or gone from the grid because it is in hand.
        const offset = preview?.offsets.get(pageNumber)
        const lifted = preview?.lifted.has(pageNumber) ?? false
        // What the cell's own paper works out to: the grid fixes every cell's
        // width, so the page's footprint fixes its height.
        const footprint = dimensionsForRotation(
          rotation,
          page.width,
          page.height,
        )
        const paperHeight =
          (THUMBNAIL_WIDTH * footprint.height) / footprint.width

        return (
          <div
            className={cn(
              "relative",
              // Only while a drag runs. It outlives the pointer by the
              // reorder's own round trip, so the transform and the transition
              // that carries it both go in the very commit that reorders the
              // pages: that commit is the no-op it looks like, not a slide
              // back out of a place the page by then really holds.
              drag && "transition-transform duration-200 ease-out",
              // The ghost carries this page; the grid it left has to read as
              // one page short, not as a page sitting under its own ghost.
              lifted && "opacity-0",
            )}
            // The whole cell, page number and badge included, answers for the
            // page it holds — `data-page-number` sits on the paper alone, which
            // would leave the caption under it a hole in the drop target.
            data-page-cell={pageNumber}
            key={`${documentId}-${pageNumber}`}
            style={{
              paddingBottom: THUMBNAIL_ROW_GAP,
              transform: offset
                ? `translate(${offset.x}px, ${offset.y}px)`
                : undefined,
            }}
          >
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
              dragging={Boolean(drag)}
              fileDropIndex={pageEdit.fileDropIndex}
              index={pageNumber}
              label={t("pageEdit.insertBefore", { pageNumber })}
              onInsert={pageEdit.onInsertBlankPage}
              paperHeight={paperHeight}
            />
            {/* The gap after the last cell of every row, not only after the
                last page: it is the same gap the next row's first cell leads
                with, but drawn where the pointer actually is — a drop on the
                right half of a row-final page would otherwise light a line a
                whole row away. It also fills the layout's right padding, so
                the row has no dead edge. */}
            {pageNumber % columns === 0 || pageNumber === pages.length ? (
              <InsertZone
                dragging={Boolean(drag)}
                fileDropIndex={pageEdit.fileDropIndex}
                index={pageNumber + 1}
                label={
                  pageNumber === pages.length
                    ? t("pageEdit.insertAtEnd")
                    : t("pageEdit.insertBefore", { pageNumber: pageNumber + 1 })
                }
                onInsert={pageEdit.onInsertBlankPage}
                paperHeight={paperHeight}
                trailing
              />
            ) : null}
          </div>
        )
      })}
      {/* Gone the moment the pointer is up, though the made way stands until
          the reorder lands. The page it names may already be out of range —
          the grid can be handed a shorter document mid-gesture — and a ghost
          is not worth taking the viewer down for. */}
      {drag && !drag.released && ghostPage ? (
        <DragGhost
          drag={drag}
          gridRef={gridRef}
          page={ghostPage}
          rotation={rotation}
        />
      ) : null}
    </div>
  )
}

type PdfViewerLayoutProps = {
  currentPage: number
  documentId: number
  draft?: RectDraft
  fileName: string
  pageEdit: PageEditProps
  pages: PdfPageInfo[]
  referencePageWidth: number
  renderEpochs: RenderEpochs
  rotation: number
  scale: number
  textEpochs: RenderEpochs
  viewMode: ViewMode
  viewerWidth: number
  textSelectionDragging: boolean
  zoomPreviewing: boolean
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
  pageEdit,
  pages,
  referencePageWidth,
  renderEpochs,
  rotation,
  scale,
  textEpochs,
  viewMode,
  viewerWidth,
  textSelectionDragging,
  zoomPreviewing,
}: PdfViewerLayoutProps) {
  const contentWidth = Math.max(0, viewerWidth - CONTENT_PADDING_X)
  const renderScale = useDebouncedValue(scale, RENDER_SETTLE_MS)
  const layoutProps = {
    contentWidth,
    documentId,
    draft,
    pages,
    referencePageWidth,
    renderEpochs,
    renderScale,
    rotation,
    scale,
    textEpochs,
    virtualizationPaused: zoomPreviewing,
    virtualizationRetainExited: textSelectionDragging,
  }

  return (
    <div
      aria-label={fileName}
      data-pdf-viewer-layout
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
      ) : (
        <SingleLayout {...layoutProps} />
      )}
    </div>
  )
}
