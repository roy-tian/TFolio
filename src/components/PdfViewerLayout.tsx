import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { ClipboardPaste, Copy, Plus, RotateCw, Scissors } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { PdfPage } from "@/components/PdfPage"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { usePageDrag, type PageDragState } from "@/hooks/usePageDrag"
import type { RectDraft } from "@/hooks/useRectTool"
import type { TextNotePreview } from "@/hooks/useTextNoteTool"
import type { RenderEpochs } from "@/lib/annotations"
import {
  orderAfterMove,
  slotOffsets,
  type CellBox,
  type PageHandoff,
} from "@/lib/pageDrag"
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

// The wheel preview already collapsed a gesture into one commit; holding the
// bitmap a little longer also coalesces rapid clicks and resize-driven fits.
const RENDER_SETTLE_MS = 150

export type PageEditProps = {
  canPaste: boolean
  /** Pages a cut is standing over: still in the document, empty for a copy. */
  cutPages: ReadonlySet<number>
  /** Where a drag over the grid would land, 1-based, or null while nothing is
      over it; the owner reads the drop, the grid only draws where it points. */
  dropIndex: number | null
  handoff: PageHandoff
  onClearSelection: () => void
  onCopyPages: () => void
  onCutPages: () => void
  onDeletePage: (pageNumber: number) => void
  onInsertBlankPage: (index: number) => void
  /** A right-click, before its menu opens: a page outside the selection
      becomes the selection, so cut and copy always mean what is on screen. */
  onMenuPage: (pageNumber: number) => void
  onPastePages: (index: number) => void
  onOpenPage: (pageNumber: number) => void
  /** Answers with the reorder's own promise, which the grid holds its make-way
      layout until: pages change only once the backend has moved them. */
  onReorderPages: (order: number[]) => void | Promise<unknown>
  onRotatePages: () => void
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
  drafts: RectDraft[]
  notes: TextNotePreview[]
  /** Copies the whole document, and stands for a select-all being in force:
      absent, a page's menu falls back to whatever the reader dragged over. */
  onCopyAllText?: () => void
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  pages: PdfPageInfo[]
  /** The document's usual page width at 100%, for a layout sharing one column. */
  referencePageWidth: number
  renderEpochs: RenderEpochs
  renderScale: number
  rotations: PageRotations
  /** Resolved zoom; the fit modes have already been worked out against it. */
  scale: number
  searchMatchesByPage: ReadonlyMap<number, IndexedPdfSearchMatch[]>
  textEpochs: RenderEpochs
  /** Freeze the current heavy-page window during compositor-only zoom. */
  virtualizationPaused: boolean
  virtualizationRetainExited: boolean
}

function SingleLayout({
  activeSearchIndex,
  documentId,
  drafts,
  notes,
  onCopyAllText,
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
      drafts={drafts}
      notes={notes}
      onCopyAllText={onCopyAllText}
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
  notes,
  onCopyAllText,
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
  // widths would read as broken.
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
          drafts={drafts}
          notes={notes}
          onCopyAllText={onCopyAllText}
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

/** How far the + and the paste button sit from the middle of the line, in CSS
    pixels: half a button each, so the two hit areas meet without overlapping. */
const PASTE_BUTTON_GAP = 14

const ZONE_SHOWN =
  "group-hover/zone:opacity-100 group-has-[:focus-visible]/zone:opacity-100"

/**
 * Only its buttons act — the gap is a target for the eye and for a drop, not a
 * click — and it carries `data-insert-index` for that drop to read.
 */
function InsertZone({
  active,
  canPaste,
  dragging,
  index,
  label,
  onInsert,
  onPaste,
  paperHeight,
  pasteLabel,
  trailing,
}: {
  /** Whether a file dragged in from the desktop would land in this gap; the
      caller resolves it so a drag re-renders two gaps, not every one. */
  active: boolean
  canPaste: boolean
  dragging: boolean
  index: number
  label: string
  onInsert: (index: number) => void
  onPaste: (index: number) => void
  /** The neighbouring page's own height: the gap's cell is taller — it holds
      the page number and row spacing — so the line sizes to the paper. */
  paperHeight: number
  pasteLabel: string
  trailing?: boolean
}) {
  return (
    <div
      className={cn(
        "group/zone absolute top-0 z-10 flex h-full flex-col items-center justify-center",
        dragging && "pointer-events-none",
      )}
      data-insert-index={index}
      // The whole gap, so every point over the grid names an insertion
      // position, and the line runs beside the paper, not the row's tallest.
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
            active && "border-l-2 border-solid border-primary opacity-100",
          )}
          style={{ height: paperHeight }}
        />
        <HintTooltip label={label}>
          <button
            aria-label={label}
            // The circle the + fades into keeps its own hit area rather than
            // borrowing the gap's: the pointer that made it appear is on it.
            className="absolute left-0 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center outline-none"
            onClick={() => onInsert(index)}
            // A press here is a press on the button, not on the grid under it.
            onPointerDown={(event) => event.stopPropagation()}
            style={{ top: paperHeight / 2 - (canPaste ? PASTE_BUTTON_GAP : 0) }}
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
        </HintTooltip>
        {canPaste ? (
          <HintTooltip label={pasteLabel}>
            <button
              aria-label={pasteLabel}
              className="absolute left-0 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center outline-none"
              onClick={() => onPaste(index)}
              onPointerDown={(event) => event.stopPropagation()}
              style={{ top: paperHeight / 2 + PASTE_BUTTON_GAP }}
              type="button"
            >
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full border border-primary bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity",
                  !dragging && ZONE_SHOWN,
                )}
              >
                <ClipboardPaste className="size-3" />
              </span>
            </button>
          </HintTooltip>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Its pixels are copied straight from the cell's canvas — a bitmap the
 * frontend already holds, the same reason page bitmaps never become `blob:`.
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

  // Runs every render deliberately: the source bitmap arrives asynchronously, so
  // a page grabbed the moment it scrolled into view has nothing to copy yet.
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
  const carried = drag.away === "carried"

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed z-50 transition-[transform,opacity] duration-150 ease-out",
        // Carried rather than placed: no grid is offering these pages a slot,
        // so the card stands aside for the tab it is about to open.
        carried && "opacity-70",
      )}
      style={{
        height,
        left: drag.pointer.x + drag.grip.x,
        top: drag.pointer.y + drag.grip.y,
        transform: carried ? "scale(0.4)" : undefined,
        // The grip's own point, so the card shrinks towards the pointer rather
        // than away from it and comes back to the same spot of itself.
        transformOrigin: `${-drag.grip.x}px ${-drag.grip.y}px`,
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
 * Read straight from the drag, so the preview and the drop that follows are
 * the same arithmetic; it lasts until the backend commits the page list.
 */
function dropPreview(
  drag: PageDragState,
  pageCount: number,
): {
  landing: CellBox | undefined
  lifted: ReadonlySet<number>
  offsets: Map<number, { x: number; y: number }>
} {
  const lifted = new Set(drag.released ? [] : drag.pages)

  // A drag the workspace has taken is on its way to another document: these
  // pages are in hand, but nothing here has anywhere to make way for.
  if (drag.away) {
    return { landing: undefined, lifted, offsets: new Map() }
  }

  const order = orderAfterMove(drag.pages, drag.gap, pageCount)

  return {
    // The block keeps its order, so its first page is where it starts.
    landing: drag.released ? undefined : drag.cells[order.indexOf(drag.pages[0]!)],
    lifted,
    offsets: slotOffsets(order, drag.cells, lifted),
  }
}

/**
 * Memoised on primitives alone: nothing here may be an object or a fresh
 * closure, either comparing unequal every render and switching the memo off.
 */
const ThumbnailCell = memo(function ThumbnailCell({
  canPaste,
  deleteDisabled,
  documentId,
  dragging,
  insertActive,
  isCurrent,
  isCut,
  isSelected,
  lifted,
  offsetX,
  offsetY,
  onDelete,
  onInsert,
  onOpen,
  onPaste,
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
  canPaste: boolean
  deleteDisabled: boolean
  documentId: number
  /** Whether a page drag has the grid — every cell carries the transition the
      make-way slide rides on, so it has to be in place before one moves. */
  dragging: boolean
  insertActive: boolean
  isCurrent: boolean
  isCut: boolean
  isSelected: boolean
  /** This page is travelling with the pointer, so the grid it left reads as one
      page short rather than as a page sitting under its own ghost. */
  lifted: boolean
  /** How far this cell slides to make way, in CSS pixels; numbers rather than
      points, a fresh object every move being what the memo cannot have. */
  offsetX: number
  offsetY: number
  onDelete: (pageNumber: number) => void
  onInsert: (index: number) => void
  onOpen: (pageNumber: number) => void
  onPaste: (index: number) => void
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  pageHeight: number
  pageNumber: number
  pageWidth: number
  released: boolean
  renderEpoch: number
  rotation: number
  selectedCount: number
  trailingInsertActive: boolean
  trailingZone: "none" | "row" | "end"
}) {
  const { t } = useTranslation()
  const footprint = dimensionsForRotation(rotation, pageWidth, pageHeight)
  const paperHeight = (THUMBNAIL_WIDTH * footprint.height) / footprint.width

  return (
    <div
      className={cn(
        // Centred so a short page stands mid-row; the cell still fills it,
        // keeping the band beside the page a named drop position.
        "relative flex flex-col justify-center",
        // Letting go places every canvas immediately; committing the page list
        // then moves the same DOM nodes and removes these offsets together.
        dragging && !released && "transition-transform duration-200 ease-out",
        lifted && "opacity-0",
      )}
      // The whole cell answers for its page: `data-page-number` sits on the
      // paper alone, leaving the caption a hole in the drop target.
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
        isCut={isCut}
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
        canPaste={canPaste}
        dragging={dragging}
        index={pageNumber}
        label={t("pageEdit.insertBefore", { pageNumber })}
        onInsert={onInsert}
        onPaste={onPaste}
        paperHeight={paperHeight}
        pasteLabel={t("pageEdit.pasteBefore", { pageNumber })}
      />
      {/* The gap after the last cell of every row: the same gap the next row's
          first cell leads with, but drawn where the pointer actually is. */}
      {trailingZone !== "none" ? (
        <InsertZone
          active={trailingInsertActive}
          canPaste={canPaste}
          dragging={dragging}
          index={pageNumber + 1}
          label={
            trailingZone === "end"
              ? t("pageEdit.insertAtEnd")
              : t("pageEdit.insertBefore", { pageNumber: pageNumber + 1 })
          }
          onInsert={onInsert}
          onPaste={onPaste}
          paperHeight={paperHeight}
          pasteLabel={
            trailingZone === "end"
              ? t("pageEdit.pasteAtEnd")
              : t("pageEdit.pasteBefore", { pageNumber: pageNumber + 1 })
          }
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
  const { t } = useTranslation()
  const columns = computeThumbnailColumns(contentWidth)
  const gridRef = useRef<HTMLDivElement>(null)
  const { drag, wasDragClick } = usePageDrag({
    active: true,
    columns,
    gridRef,
    handoff: pageEdit.handoff,
    layoutVersion: pages,
    onReorder: pageEdit.onReorderPages,
    pageCount: pages.length,
    selectedPages: pageEdit.selectedPages,
  })
  // Latched so the memoised cells see the same callbacks throughout a drag —
  // the grid re-renders on every pointer move of one.
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
  const pastePages = useCallback(
    (index: number) => pageEditRef.current.onPastePages(index),
    [],
  )
  const cutPages = useCallback(() => pageEditRef.current.onCutPages(), [])
  const copyPages = useCallback(() => pageEditRef.current.onCopyPages(), [])
  const rotatePages = useCallback(() => pageEditRef.current.onRotatePages(), [])
  // One menu for the whole grid: one per cell would mount hundreds of popup
  // roots, each with a document listener, for a gesture that happens once.
  const [menuPage, setMenuPage] = useState<number | null>(null)
  const pressedPage = useRef<number | null>(null)
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
  const { canPaste, cutPages: cut, dropIndex, selectedPages } = pageEdit

  // What the menu's own entries act on: the selection when the press landed in
  // it, and otherwise the one page `onMenuPage` is about to make the selection.
  const menuCount =
    menuPage !== null && selectedPages.has(menuPage) ? selectedPages.size : 1

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) {
          setMenuPage(null)

          return
        }

        const pageNumber = pressedPage.current

        // A press on a gap, or past the last page, opens nothing: the entries
        // here are a page's, and the gaps have buttons of their own.
        if (pageNumber !== null) {
          pageEditRef.current.onMenuPage(pageNumber)
        }

        setMenuPage(pageNumber)
      }}
      open={menuPage !== null}
    >
      <ContextMenuTrigger
        className="relative grid"
        // Read here rather than from the open below, which is handed no event:
        // Base UI runs this before its own handler opens the menu.
        onContextMenu={(event) => {
          const cell =
            event.target instanceof Element
              ? event.target.closest("[data-page-cell]")
              : null

          pressedPage.current = cell
            ? Number(cell.getAttribute("data-page-cell"))
            : null
        }}
        ref={gridRef}
        // The row gap is the cells' own bottom padding, so every point between
        // two rows still names a position instead of falling to the workspace.
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
              canPaste={canPaste}
              deleteDisabled={
                pages.length === 1 ||
                // Deleting a selected page takes the whole selection; when that
                // is every page the backend refuses, so the button is disabled.
                (isSelected && selectedPages.size === pages.length)
              }
              documentId={documentId}
              dragging={dragging}
              insertActive={dropIndex === pageNumber}
              isCurrent={currentPage === pageNumber}
              isCut={cut.has(pageNumber)}
              isSelected={isSelected}
              key={`${documentId}-${pageEdit.thumbnailKeys[index]}`}
              lifted={preview?.lifted.has(pageNumber) ?? false}
              offsetX={offset?.x ?? 0}
              offsetY={offset?.y ?? 0}
              onDelete={deletePage}
              onInsert={insertPage}
              onOpen={openPage}
              onPaste={pastePages}
              onSelect={selectPage}
              pageHeight={page.height}
              pageNumber={pageNumber}
              pageWidth={page.width}
              released={drag?.released ?? false}
              renderEpoch={renderEpochs[pageNumber] ?? 0}
              rotation={rotationForPage(rotations, pageNumber)}
              // Only a page the delete would take the selection with needs the
              // count; the rest would re-render the grid on every selection change.
              selectedCount={isSelected ? selectedPages.size : 1}
              // Only where that gap is actually drawn: a cell with none of its
              // own must not re-render for a drop it cannot show.
              trailingInsertActive={
                trailingZone !== "none" && dropIndex === pageNumber + 1
              }
              trailingZone={trailingZone}
            />
          )
        })}
        {/* Portalled to the body: this grid is hidden the moment the workspace
            opens another tab under the drag, and the pages stay in hand. */}
        {drag && !drag.released && ghostPage
          ? createPortal(
              <DragGhost
                drag={drag}
                gridRef={gridRef}
                page={ghostPage}
                rotation={rotationForPage(rotations, drag.lead)}
              />,
              document.body,
            )
          : null}
      </ContextMenuTrigger>
      {/* A paste is a position rather than a page, so it stays with the gaps
          and their + rather than this page menu. */}
      <ContextMenuContent>
        <ContextMenuItem data-action="cut-pages" onClick={cutPages}>
          <Scissors />
          {t("pageEdit.cut", { count: menuCount })}
        </ContextMenuItem>
        <ContextMenuItem data-action="copy-pages" onClick={copyPages}>
          <Copy />
          {t("pageEdit.copy", { count: menuCount })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-action="rotate-pages" onClick={rotatePages}>
          <RotateCw />
          {t("pageEdit.rotate", { count: menuCount })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

type PdfViewerLayoutProps = {
  activeSearchIndex: number | null
  currentPage: number
  documentId: number
  drafts: RectDraft[]
  notes: TextNotePreview[]
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
  /** Whether the whole document's text stands selected; the highlight over the
      runs is drawn from the attribute this sets, not by the WebView. */
  textSelectAll: boolean
  onCopyAllText: () => void
  viewMode: ViewMode
  viewerWidth: number
  textSelectionDragging: boolean
  zoomPreviewing: boolean
}

/**
 * Every mode tags its pages with `data-page-number`, which is what lets page
 * tracking and navigation stay layout agnostic.
 */
export function PdfViewerLayout({
  activeSearchIndex,
  currentPage,
  documentId,
  drafts,
  notes,
  onCopyAllText,
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
  textSelectAll,
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
    notes,
    onCopyAllText: textSelectAll ? onCopyAllText : undefined,
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
      data-select-all={textSelectAll}
      data-view-mode={viewMode}
      onClick={(event) => {
        if (viewMode !== "thumbnail") {
          return
        }

        const target = event.target

        // The portalled menu items still bubble here through the React tree,
        // so choosing one is not a press on blank space; everything else clears.
        if (
          !(target instanceof Element) ||
          !target.closest("button, [data-slot='context-menu-content']")
        ) {
          pageEdit.onClearSelection()
        }
      }}
      // `min-w-fit` keeps a zoomed-in page reachable: centring an overflowing
      // box would split the overflow, its left half at an unreachable offset.
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
