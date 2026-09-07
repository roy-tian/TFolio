import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PdfPage } from "@/components/PdfPage"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { usePageDrag, type PageDragState } from "@/hooks/usePageDrag"
import type { RectDraft } from "@/hooks/useRectTool"
import type { RenderEpochs } from "@/lib/annotations"
import { orderAfterMove, slotOffsets, type CellBox } from "@/lib/pageDrag"
import {
  rotationForPage,
  type PageRotations,
} from "@/lib/pageRotation"
import {
  dimensionsForRotation,
  type PdfPageInfo,
  type PdfSearchMatch,
} from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import {
  computeThumbnailColumns,
  pairPages,
  THUMBNAIL_CAPTION_HEIGHT,
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
  onClearSelection: () => void
  onDeletePage: (pageNumber: number) => void
  onInsertBlankPage: (index: number) => void
  /** Double-click: leave the grid for the page itself. */
  onOpenPage: (pageNumber: number) => void
  /** Answers with the reorder's own promise, which the grid holds its
      make-way layout until: the pages change only once the backend has moved
      them. */
  onReorderPages: (order: number[]) => void | Promise<unknown>
  /** Stable across reorders, so painted canvases move with their pages. */
  thumbnailKeys: number[]
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  selectedPages: ReadonlySet<number>
}

export type IndexedPdfSearchMatch = {
  index: number
  match: PdfSearchMatch
}

const NO_SEARCH_MATCHES: IndexedPdfSearchMatch[] = []

type LayoutProps = {
  activeSearchIndex: number | null
  /** Width left for pages once the column's padding is taken out. */
  contentWidth: number
  documentId: number
  /** Live and released rectangle previews, each tied to its starting page. */
  drafts: RectDraft[]
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  pages: PdfPageInfo[]
  /** The document's usual page width at 100%, for a layout sharing one column. */
  referencePageWidth: number
  /** How many times each page has been drawn on, keyed by page number. */
  renderEpochs: RenderEpochs
  renderScale: number
  rotations: PageRotations
  /** Resolved zoom; the fit modes have already been worked out against it. */
  scale: number
  searchMatchesByPage: ReadonlyMap<number, IndexedPdfSearchMatch[]>
  /** How many times each page's extracted text has changed. */
  textEpochs: RenderEpochs
  /** Freeze the current heavy-page window during compositor-only zoom. */
  virtualizationPaused: boolean
  /** Preserve pages already crossed by an active text-selection drag. */
  virtualizationRetainExited: boolean
}

function SingleLayout({
  activeSearchIndex,
  documentId,
  drafts,
  onPagePaint,
  pages,
  renderEpochs,
  renderScale,
  rotations,
  scale,
  searchMatchesByPage,
  textEpochs,
  virtualizationPaused,
  virtualizationRetainExited,
}: LayoutProps) {
  return pages.map((page, index) => (
    <PdfPage
      documentId={documentId}
      drafts={drafts.filter((draft) => draft.pageNumber === index + 1)}
      onPagePaint={onPagePaint}
      key={`${documentId}-${index + 1}`}
      page={page}
      pageNumber={index + 1}
      renderEpoch={renderEpochs[index + 1] ?? 0}
      renderScale={renderScale}
      rotation={rotationForPage(rotations, index + 1)}
      scale={scale}
      searchMatches={searchMatchesByPage.get(index + 1) ?? NO_SEARCH_MATCHES}
      activeSearchIndex={activeSearchIndex}
      textEpoch={textEpochs[index + 1] ?? 0}
      virtualizationPaused={virtualizationPaused}
      virtualizationRetainExited={virtualizationRetainExited}
    />
  ))
}

function BookLayout({
  activeSearchIndex,
  documentId,
  drafts,
  onPagePaint,
  pages,
  referencePageWidth,
  renderEpochs,
  renderScale,
  rotations,
  scale,
  searchMatchesByPage,
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
          drafts={drafts.filter((draft) => draft.pageNumber === pageNumber)}
          onPagePaint={onPagePaint}
          key={`${documentId}-${pageNumber}`}
          page={pages[pageNumber - 1]}
          pageNumber={pageNumber}
          renderEpoch={renderEpochs[pageNumber] ?? 0}
          renderScale={renderScale}
          renderWidth={renderColumnWidth}
          rotation={rotationForPage(rotations, pageNumber)}
          scale={scale}
          searchMatches={searchMatchesByPage.get(pageNumber) ?? NO_SEARCH_MATCHES}
          activeSearchIndex={activeSearchIndex}
          textEpoch={textEpochs[pageNumber] ?? 0}
          virtualizationPaused={virtualizationPaused}
          virtualizationRetainExited={virtualizationRetainExited}
          width={columnWidth}
        />
      ))}
    </div>
  ))
}

/** What draws the line and the +: a hover anywhere in the gap, or a keyboard
    reaching the button inside it. */
const ZONE_SHOWN =
  "group-hover/zone:opacity-100 group-has-[:focus-visible]/zone:opacity-100"

/**
 * The gap beside a thumbnail: it fills the space between the two pages, so
 * hovering anywhere in there shows a dashed insertion line down the middle of
 * the gap and, on the line, the + that inserts a blank page. Only that button
 * inserts — the gap is a target for the eye and for a drop, not for a click, so
 * reaching past a page cannot add one. The same line, solid, marks where a PDF
 * dragged in from the desktop would land — which is why the zone carries its own
 * position as `data-insert-index`, for the drop to read off the element under
 * the pointer. A page dragged *within* the grid says it differently: the cells
 * themselves move aside, so while that gesture runs the zone shows nothing and
 * goes inert, leaving it the pointer.
 */
function InsertZone({
  active,
  dragging,
  index,
  label,
  onInsert,
  paperHeight,
  trailing,
}: {
  /** Whether a file dragged in from the desktop would land in this gap.
      Resolved by the caller rather than compared against the drop position
      here, so a drag over the grid re-renders the two gaps it names instead of
      every gap in the document. */
  active: boolean
  /** Whether a page drag has the grid, which mutes every zone. */
  dragging: boolean
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
  return (
    <div
      className={cn(
        "group/zone absolute top-0 z-10 flex h-full flex-col items-center justify-center",
        dragging && "pointer-events-none",
      )}
      data-insert-index={index}
      // The whole gap, so every point over the grid names an insertion position
      // — the cells answer for themselves — and the line lands in its middle.
      // The cell beside it centres its page in the row and hangs the page
      // number under it, so this column stands the same way: what the line runs
      // beside is that page's own paper, not the row's tallest.
      style={{
        [trailing ? "right" : "left"]: -THUMBNAIL_COLUMN_GAP,
        paddingBottom: THUMBNAIL_ROW_GAP,
        width: THUMBNAIL_COLUMN_GAP,
      }}
    >
      <div
        className="relative w-0"
        style={{ height: `calc(${paperHeight}px + ${THUMBNAIL_CAPTION_HEIGHT})` }}
      >
        <span
          className={cn(
            "pointer-events-none absolute left-0 top-0 w-0 border-l border-dashed border-primary/50 opacity-0 transition-opacity",
            !dragging && ZONE_SHOWN,
            // A drop lands somewhere definite, so that line speaks up.
            active && "border-l-2 border-solid border-primary opacity-100",
          )}
          style={{ height: paperHeight }}
        />
        <button
          aria-label={label}
          // The button is the whole target and nothing else in the gap is, so
          // the circle it fades in is the only place a page can be added from.
          // It keeps its own hit area rather than borrowing the gap's: the
          // pointer that made it appear is already on it.
          className="absolute left-0 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center outline-none"
          onClick={() => onInsert(index)}
          // A press here is a press on the button, not on the grid under it.
          onPointerDown={(event) => event.stopPropagation()}
          style={{ top: paperHeight / 2 }}
          title={label}
          type="button"
        >
          <span
            className={cn(
              "grid size-5 place-items-center rounded-full border border-primary bg-background text-primary opacity-0 shadow-sm transition-opacity",
              !dragging && ZONE_SHOWN,
              active && "opacity-100",
            )}
          >
            <Plus className="size-3" />
          </span>
        </button>
      </div>
    </div>
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
 * On release, the lifted pages fill their slots immediately using the canvases
 * already painted. This layout lasts until the backend commits the page list.
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
  const lifted = new Set(drag.released ? [] : drag.pages)

  return {
    // The block keeps its order, so its first page is where it starts.
    landing: drag.released ? undefined : drag.cells[order.indexOf(drag.pages[0]!)],
    lifted,
    offsets: slotOffsets(order, drag.cells, lifted),
  }
}

/**
 * One cell of the grid: a page's preview, the gap before it, and — at the end
 * of a row — the gap after it.
 *
 * Memoised on primitives alone, which is what keeps a long document usable. The
 * grid re-renders on every pointer move of a page drag and again after every
 * edit; an unmemoised cell takes its whole subtree through each of those — an
 * intersection observer, a translation lookup, a bitmap effect — and several
 * hundred of them turn a drag into something the reader can feel. So nothing
 * here may be an object or a fresh closure: either compares unequal on every
 * render and switches the memo back off.
 */
const ThumbnailCell = memo(function ThumbnailCell({
  deleteDisabled,
  documentId,
  dragging,
  insertActive,
  isCurrent,
  isSelected,
  lifted,
  offsetX,
  offsetY,
  onDelete,
  onInsert,
  onOpen,
  onSelect,
  pageHeight,
  pageNumber,
  pageWidth,
  released,
  renderEpoch,
  rotation,
  selectedCount,
  trailingInsertActive,
  trailingZone,
}: {
  deleteDisabled: boolean
  documentId: number
  /** Whether a page drag has the grid — every cell carries the transition the
      make-way slide rides on, so it has to be in place before one moves. */
  dragging: boolean
  /** Whether a file dragged in from the desktop would land in the gap before
      this page, and — below — in the gap after it. */
  insertActive: boolean
  isCurrent: boolean
  isSelected: boolean
  /** This page is travelling with the pointer, so the grid it left reads as one
      page short rather than as a page sitting under its own ghost. */
  lifted: boolean
  /** How far this cell slides to make way for the drop, in CSS pixels. Numbers
      rather than the point they came from: a fresh object every pointer move is
      exactly what the memo above cannot have. */
  offsetX: number
  offsetY: number
  onDelete: (pageNumber: number) => void
  onInsert: (index: number) => void
  onOpen: (pageNumber: number) => void
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  pageHeight: number
  pageNumber: number
  pageWidth: number
  released: boolean
  renderEpoch: number
  rotation: number
  selectedCount: number
  trailingInsertActive: boolean
  /** Which gap follows this cell: none, the one closing its row, or the one
      past the last page of the document. */
  trailingZone: "none" | "row" | "end"
}) {
  const { t } = useTranslation()
  // What the cell's own paper works out to: the grid fixes every cell's width,
  // so the page's footprint fixes its height.
  const footprint = dimensionsForRotation(rotation, pageWidth, pageHeight)
  const paperHeight = (THUMBNAIL_WIDTH * footprint.height) / footprint.width

  return (
    <div
      className={cn(
        // Centred, so a page shorter than the row it sits in — a landscape page
        // among portrait ones — stands in the middle of its row rather than
        // hanging from the top of it. The cell itself still fills the row: the
        // band beside a short page has to keep naming its position for a file
        // dragged across the grid.
        "relative flex flex-col justify-center",
        // Letting go places every canvas immediately; committing the page list
        // then moves the same DOM nodes and removes these offsets together.
        dragging && !released && "transition-transform duration-200 ease-out",
        // The ghost carries this page; the grid it left has to read as one page
        // short, not as a page sitting under its own ghost.
        lifted && "opacity-0",
      )}
      // The whole cell, page number and badge included, answers for the page it
      // holds — `data-page-number` sits on the paper alone, which would leave
      // the caption under it a hole in the drop target.
      data-page-cell={pageNumber}
      style={{
        paddingBottom: THUMBNAIL_ROW_GAP,
        transform:
          offsetX !== 0 || offsetY !== 0
            ? `translate(${offsetX}px, ${offsetY}px)`
            : undefined,
      }}
    >
      <PdfThumbnail
        deleteDisabled={deleteDisabled}
        documentId={documentId}
        isCurrent={isCurrent}
        isSelected={isSelected}
        onDelete={onDelete}
        onOpen={onOpen}
        onSelect={onSelect}
        pageHeight={pageHeight}
        pageNumber={pageNumber}
        pageWidth={pageWidth}
        renderEpoch={renderEpoch}
        rotation={rotation}
        selectedCount={selectedCount}
        width={THUMBNAIL_WIDTH}
      />
      <InsertZone
        active={insertActive}
        dragging={dragging}
        index={pageNumber}
        label={t("pageEdit.insertBefore", { pageNumber })}
        onInsert={onInsert}
        paperHeight={paperHeight}
      />
      {/* The gap after the last cell of every row, not only after the last
          page: it is the same gap the next row's first cell leads with, but
          drawn where the pointer actually is — a drop on the right half of a
          row-final page would otherwise light a line a whole row away. It also
          fills the layout's right padding, so the row has no dead edge. */}
      {trailingZone !== "none" ? (
        <InsertZone
          active={trailingInsertActive}
          dragging={dragging}
          index={pageNumber + 1}
          label={
            trailingZone === "end"
              ? t("pageEdit.insertAtEnd")
              : t("pageEdit.insertBefore", { pageNumber: pageNumber + 1 })
          }
          onInsert={onInsert}
          paperHeight={paperHeight}
          trailing
        />
      ) : null}
    </div>
  )
})

function ThumbnailLayout({
  contentWidth,
  currentPage,
  documentId,
  pageEdit,
  pages,
  renderEpochs,
  rotations,
}: LayoutProps & {
  currentPage: number
  pageEdit: PageEditProps
}) {
  const columns = computeThumbnailColumns(contentWidth)
  const gridRef = useRef<HTMLDivElement>(null)
  const { drag, wasDragClick } = usePageDrag({
    active: true,
    columns,
    gridRef,
    layoutVersion: pages,
    onReorder: pageEdit.onReorderPages,
    pageCount: pages.length,
    selectedPages: pageEdit.selectedPages,
  })
  // The owner hands its handlers down fresh on every render, and this grid
  // re-renders on every pointer move of a drag. Latched here, the cells below
  // see the same four callbacks throughout a gesture and can stand still — the
  // same reason `usePageDrag` holds its own `onReorder` this way.
  const pageEditRef = useRef(pageEdit)

  pageEditRef.current = pageEdit

  const deletePage = useCallback(
    (pageNumber: number) => pageEditRef.current.onDeletePage(pageNumber),
    [],
  )
  const openPage = useCallback(
    (pageNumber: number) => pageEditRef.current.onOpenPage(pageNumber),
    [],
  )
  const insertPage = useCallback(
    (index: number) => pageEditRef.current.onInsertBlankPage(index),
    [],
  )
  const selectPage = useCallback(
    (pageNumber: number, modifiers: SelectionModifiers) => {
      // The click a finished drag releases is the gesture ending, not a choice.
      if (wasDragClick()) {
        return
      }

      pageEditRef.current.onSelectPage(pageNumber, modifiers)
    },
    [wasDragClick],
  )

  const preview = useMemo(
    () => (drag ? dropPreview(drag, pages.length) : null),
    [drag, pages.length],
  )
  const ghostPage = drag ? pages[drag.lead - 1] : undefined
  const dragging = Boolean(drag)
  const { fileDropIndex, selectedPages } = pageEdit

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
            // The cell carries the row gap as its own bottom padding, which
            // lies between two slots rather than in either.
            height: preview.landing.height - THUMBNAIL_ROW_GAP,
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
        const isSelected = selectedPages.has(pageNumber)
        const trailingZone =
          pageNumber === pages.length
            ? "end"
            : pageNumber % columns === 0
              ? "row"
              : "none"

        return (
          <ThumbnailCell
            deleteDisabled={
              pages.length === 1 ||
              // Deleting a selected page takes the whole selection; when that
              // is every page the backend refuses it, so the button that would
              // silently do nothing is disabled instead.
              (isSelected && selectedPages.size === pages.length)
            }
            documentId={documentId}
            dragging={dragging}
            insertActive={fileDropIndex === pageNumber}
            isCurrent={currentPage === pageNumber}
            isSelected={isSelected}
            key={`${documentId}-${pageEdit.thumbnailKeys[index]}`}
            lifted={preview?.lifted.has(pageNumber) ?? false}
            offsetX={offset?.x ?? 0}
            offsetY={offset?.y ?? 0}
            onDelete={deletePage}
            onInsert={insertPage}
            onOpen={openPage}
            onSelect={selectPage}
            pageHeight={page.height}
            pageNumber={pageNumber}
            pageWidth={page.width}
            released={drag?.released ?? false}
            renderEpoch={renderEpochs[pageNumber] ?? 0}
            rotation={rotationForPage(rotations, pageNumber)}
            // Only a page the delete would actually take the selection with
            // needs the count; giving it to the rest would re-render the whole
            // grid every time the selection grew by one.
            selectedCount={isSelected ? selectedPages.size : 1}
            // Only where that gap is actually drawn: a cell with none of its
            // own must not re-render for a drop it cannot show.
            trailingInsertActive={
              trailingZone !== "none" && fileDropIndex === pageNumber + 1
            }
            trailingZone={trailingZone}
          />
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
          rotation={rotationForPage(rotations, drag.lead)}
        />
      ) : null}
    </div>
  )
}

type PdfViewerLayoutProps = {
  activeSearchIndex: number | null
  currentPage: number
  documentId: number
  drafts: RectDraft[]
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  fileName: string
  pageEdit: PageEditProps
  pages: PdfPageInfo[]
  referencePageWidth: number
  renderEpochs: RenderEpochs
  rotations: PageRotations
  scale: number
  searchMatchesByPage: ReadonlyMap<number, IndexedPdfSearchMatch[]>
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
  activeSearchIndex,
  currentPage,
  documentId,
  drafts,
  onPagePaint,
  fileName,
  pageEdit,
  pages,
  referencePageWidth,
  renderEpochs,
  rotations,
  scale,
  searchMatchesByPage,
  textEpochs,
  viewMode,
  viewerWidth,
  textSelectionDragging,
  zoomPreviewing,
}: PdfViewerLayoutProps) {
  const contentWidth = Math.max(0, viewerWidth - CONTENT_PADDING_X)
  const renderScale = useDebouncedValue(scale, RENDER_SETTLE_MS)
  const layoutProps = {
    activeSearchIndex,
    contentWidth,
    documentId,
    drafts,
    onPagePaint,
    pages,
    referencePageWidth,
    renderEpochs,
    renderScale,
    rotations,
    scale,
    searchMatchesByPage,
    textEpochs,
    virtualizationPaused: zoomPreviewing,
    virtualizationRetainExited: textSelectionDragging,
  }

  return (
    <div
      aria-label={fileName}
      data-pdf-viewer-layout
      onClick={(event) => {
        if (viewMode !== "thumbnail") {
          return
        }

        const target = event.target

        // A page or editing control owns its click. Everything else in this
        // layout is blank grid or workspace and clears the thumbnail choice.
        if (!(target instanceof Element) || !target.closest("button")) {
          pageEdit.onClearSelection()
        }
      }}
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
