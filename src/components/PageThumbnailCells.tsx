import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { ChevronRight, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { FileTitleEditor } from "@/components/FileTitleEditor"
import { PaddingDismiss } from "@/components/PaddingDismiss"
import { PageControls, type PageActionHandler } from "@/components/PageCardControls"
import { DragHole } from "@/components/PageDragGhost"
import { HintTooltip } from "@/components/HintTooltip"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { PageSignatureMark } from "@/components/SignatureBadge"
import { dropEdgeOrigin, SidebarDropEdge } from "@/components/SidebarFileDrop"
import { useNearViewport } from "@/hooks/useNearViewport"
import { useSidebarDrop, useSidebarDropPoint } from "@/hooks/useSidebarDrop"
import type { CarriedPages } from "@/lib/pageCarry"
import { flowCells } from "@/lib/pageDrag"
import type { ParkedPreviews } from "@/lib/parkedPreviews"
import type { PaddingSheet } from "@/lib/padding"
import { dimensionsForRotation } from "@/lib/pdf"
import { THUMBNAIL_COLUMN_GAP, THUMBNAIL_GRID_GAP } from "@/lib/sidebar"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"

// A blank's way in, as tall as its button, where one column's gap is narrower.
const INSERT_SEAM = 20

/** The name of a file's pages under one heading: the handle a press chooses
    the file by, a drag carries it by, and a folded file's ghost lands on. */
export const FILE_HEADING_NAME = "[data-slot='pages-file-heading']"

/** The flip key of a folded file's bar, by the preview key of its first page. */
export function foldedBarKey(firstKey: number) {
  return `fold-${firstKey}`
}

/** While a file drag offers the sidebar, an edge around the pages and, once
    the drag is over the sidebar, a bar where the files would go. What a drop
    does is said in the bar over the pages, where it covers none of them. */
export function PagesDropTarget({
  flowRef,
  grid,
  slot,
}: {
  flowRef: RefObject<HTMLOListElement | null>
  /** Whether the pages stand in rows of several, not down one column. */
  grid: boolean
  /** The cell of the flow the files would go in front of, as the pages
      worked it out; the flow's length for after the last. */
  slot: number | null
}) {
  const drop = useSidebarDrop()

  return (
    <SidebarDropEdge>
      {drop === "over" && slot !== null ? (
        <DropMarker flowRef={flowRef} grid={grid} slot={slot} />
      ) : null}
    </SidebarDropEdge>
  )
}

/** The bar between the pages the files would go between, drawn over the flow
    in the drop target's own space. Placed again as the point moves or the
    flow scrolls under it, re-rendering nothing else. */
function DropMarker({
  flowRef,
  grid,
  slot,
}: {
  flowRef: RefObject<HTMLOListElement | null>
  grid: boolean
  slot: number
}) {
  // Read for the scroll an edge brings, which moves the cells under it.
  const point = useSidebarDropPoint()
  const markerRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ height: number; left: number; top: number; width: number } | null>(
    null,
  )

  useLayoutEffect(() => {
    const flow = flowRef.current
    const host = markerRef.current?.parentElement

    if (!flow || !host) {
      setBox(null)
      return
    }

    // By cells, which the marker stands between: the drop itself counts
    // pages, a folded file's name being one cell of many.
    const cells = flowCells(flow, () => false)
    const landing = cells[Math.min(slot, cells.length - 1)]

    if (!landing) {
      setBox(null)
      return
    }

    // In the middle of the flow's own gap, off the cell's edge rather than the
    // paper's: a portrait paper stands inside its square, a caption below it.
    const cell = landing.element
    const style = getComputedStyle(flow)
    const edge = cell.getBoundingClientRect()
    const paper = (cell.querySelector("[data-thumbnail-page]") ?? cell).getBoundingClientRect()
    const origin = dropEdgeOrigin(host)
    const after = slot >= cells.length

    // A folded file's name is a row of its own, whatever stands around it.
    if (grid && !landing.bar) {
      const half = parseFloat(style.columnGap) / 2 || 0

      setBox({
        height: paper.height,
        left: (after ? edge.right + half : edge.left - half) - origin.left - 1.5,
        top: paper.top - origin.top,
        width: 3,
      })
    } else {
      const half = parseFloat(style.rowGap) / 2 || 0

      setBox({
        height: 3,
        left: paper.left - origin.left,
        top: (after ? edge.bottom + half : edge.top - half) - origin.top - 1.5,
        width: paper.width,
      })
    }
  }, [flowRef, grid, point, slot])

  return (
    <div
      className="absolute rounded-full bg-primary"
      data-testid="pages-drop-marker"
      hidden={box === null}
      ref={markerRef}
      style={box ?? undefined}
    />
  )
}

/** Where another document's pages will stand, one hole each, keyed apart from
    every page; a fragment, so each is a cell of the flow's own. Turned as
    this view turns its pages, which the copies take on, not as the source's. */
export function CarriedHoles({
  carryKey,
  frame,
  rotation,
  sizes,
}: {
  carryKey: string
  frame: number | null
  rotation: number
  sizes: CarriedPages["sizes"]
}) {
  return sizes.map((size, index) => {
    const paper = thumbnailPaper(dimensionsForRotation(rotation, size.width, size.height))

    return (
      <li className="relative" data-flip-key={`${carryKey}${index}`} key={index}>
        <div
          style={{
            height: `calc(${frame ?? paper.height}px + ${THUMBNAIL_CAPTION_HEIGHT})`,
            width: frame ?? paper.width,
          }}
        />
        <DragHole
          height={paper.height}
          top={frame === null ? 0 : (frame - paper.height) / 2}
          width={paper.width}
        />
      </li>
    )
  })
}

/** A blank page a Save As will add, where it will add it: white paper with a
    dashed edge, no page of the document's own, so nothing to choose or drag,
    and on it the way to save without such pages.
    No flip key, so a drop counts it no cell. */
export function PaddingCell({
  frame,
  label,
  onDismiss,
  rotation,
  sheet,
}: {
  frame: number | null
  label: string
  onDismiss: () => void
  rotation: number
  sheet: PaddingSheet
}) {
  const paper = thumbnailPaper(dimensionsForRotation(rotation, sheet.width, sheet.height))

  return (
    <li className="flex flex-col items-center" data-padding-after={sheet.after}>
      <div
        className="grid place-items-center"
        style={frame === null ? undefined : { height: frame, width: frame }}
      >
        <HintTooltip label={label}>
          <div
            aria-label={label}
            className="grid place-items-center border-2 border-dashed border-muted-foreground/40 bg-white p-1"
            role="group"
            style={{ height: paper.height, width: paper.width }}
          >
            <PaddingDismiss onDismiss={onDismiss} />
          </div>
        </HintTooltip>
      </div>
      <span style={{ height: THUMBNAIL_CAPTION_HEIGHT }} />
    </li>
  )
}

/**
 * The name over a file's pages, in a document of several: a press chooses
 * the file, a drag carries it whole, and its arrow folds the pages away under
 * it. Folded, it is a cell of the flow that stands for them — a bar a drop
 * lands above or below — and says how many it holds.
 */
export function FileHeading({
  count,
  current,
  flipKey,
  folded,
  hole,
  onFold,
  onRename,
  onRenameDone,
  onSelect,
  renaming,
  runFirst,
  section,
  selected,
  title,
}: {
  /** The pages under this name, where they stand together. */
  count: number
  /** Folded over the page being read. */
  current: boolean
  flipKey: string
  folded: boolean
  /** Folded and in hand: its place shows where the file will land. */
  hole: boolean
  onFold: (folded: boolean) => void
  onRename: () => void
  onRenameDone: (title: string | null) => void
  onSelect: (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
  renaming: boolean
  /** The first page under the name, which tells one run of a parted file
      from the other. */
  runFirst: number
  section: number
  /** Folded, with every page under the name chosen. */
  selected: boolean
  title: string
}) {
  const { t } = useTranslation()
  const foldLabel = t(folded ? "sidebar.unfoldItem" : "sidebar.foldItem", { name: title })

  return (
    <li
      // No flip key while its pages show: a heading is no page, and a drop
      // counts none.
      className={cn("relative flex w-full basis-full items-center gap-0.5 px-1", !folded && "pt-1")}
      data-flip-bar={folded ? "" : undefined}
      data-flip-key={folded ? flipKey : undefined}
      data-run-first={runFirst}
      data-section-header={section}
    >
      {/* Faded rather than hidden, as a page in hand is: a hidden button
          would give up its focus, and the flow's keys with it. */}
      <div className={cn("flex min-w-0 flex-1 items-center gap-0.5", hole && "opacity-0")}>
        <button
          aria-expanded={!folded}
          aria-label={foldLabel}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          data-fold-toggle
          onClick={() => onFold(!folded)}
          type="button"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", !folded && "rotate-90")} />
        </button>
        {renaming ? (
          <FileTitleEditor
            className="h-6 max-w-64 text-xs"
            label={t("sidebar.fileName")}
            onDone={onRenameDone}
            title={title}
          />
        ) : (
          <button
            aria-current={current ? "page" : undefined}
            aria-pressed={folded ? selected : undefined}
            className={cn(
              "min-w-0 cursor-grab truncate rounded px-1 text-left text-xs font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              current && "text-foreground",
              selected && "bg-primary/10 text-foreground ring-1 ring-primary hover:bg-primary/15",
            )}
            data-slot="pages-file-heading"
            onClick={onSelect}
            onDoubleClick={onRename}
            type="button"
          >
            {title}
          </button>
        )}
        {folded && !renaming ? (
          <span
            className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground tabular-nums"
            data-slot="pages-file-count"
          >
            {t("sidebar.filePages", { count })}
          </span>
        ) : null}
      </div>
      {hole ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 inset-y-0 rounded border-2 border-dashed border-primary/60 bg-primary/5"
        />
      ) : null}
    </li>
  )
}

/** A blank page's way in, in the gap before a page — beside it across a row,
    above it down one column: shown under the pointer or the keyboard's focus
    only, since a row of plus signs would crowd the pages. */
function InsertGap({
  frame,
  label,
  onInsert,
  side,
}: {
  frame: number | null
  label: string
  onInsert: () => void
  side: "before" | "after"
}) {
  return (
    <div
      // Only the button takes a press: down one column the seam reaches a
      // little over the papers it lies between.
      className="pointer-events-none absolute z-10 grid place-items-center in-data-[pages-dragging]:hidden"
      data-page-control
      style={
        frame === null
          ? {
              [side === "before" ? "top" : "bottom"]: -(THUMBNAIL_COLUMN_GAP + INSERT_SEAM) / 2,
              height: INSERT_SEAM,
              left: 0,
              right: 0,
            }
          : {
              [side === "before" ? "left" : "right"]: -THUMBNAIL_GRID_GAP,
              height: frame,
              top: 0,
              width: THUMBNAIL_GRID_GAP,
            }
      }
    >
      <HintTooltip label={label}>
        <button
          aria-label={label}
          className="pointer-events-auto grid size-5 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 in-data-[pages-busy]:cursor-wait"
          data-insert-gap={side}
          onClick={onInsert}
          type="button"
        >
          <Plus className="size-3.5" />
        </button>
      </HintTooltip>
    </div>
  )
}

/** Memoised on primitives alone, so the reader's page moving re-renders the
    two previews it moves between, not the flow. */
export const PageCell = memo(function PageCell({
  caption,
  deleteDisabled,
  documentId,
  flipKey,
  frame,
  hole,
  intrinsicRotation,
  isCurrent,
  isCut,
  isLast,
  isSelected,
  label,
  onAction,
  onInsertBlank,
  onSelect,
  pageHeight,
  pageNumber,
  pageWidth,
  parked,
  renderEpoch,
  rotation,
  signed,
}: {
  caption: number
  deleteDisabled: boolean
  documentId: number
  flipKey: number
  /** The square cell of a sidebar wide enough for rows of several, or null
      down its one column. */
  frame: number | null
  /** The page is in hand: its place shows where it will land. */
  hole: boolean
  intrinsicRotation: number
  isCurrent: boolean
  isCut: boolean
  /** The last page also offers a blank after it. */
  isLast: boolean
  isSelected: boolean
  label: string
  onAction: PageActionHandler
  /** A blank before the page, or after it from the last page's gap. */
  onInsertBlank: (pageNumber: number, side: "before" | "after") => void
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  pageHeight: number
  pageNumber: number
  pageWidth: number
  parked: ParkedPreviews
  renderEpoch: number
  rotation: number
  signed: boolean
}) {
  const { t } = useTranslation()
  const itemRef = useRef<HTMLLIElement>(null)
  const nearView = useNearViewport(itemRef, RETAIN_MARGIN)
  // A focused control stays however far the pages scroll from it: unmounting
  // it would drop keyboard focus back to the start of the document.
  const [focusWithin, setFocusWithin] = useState(false)
  const paper = thumbnailPaper(dimensionsForRotation(rotation, pageWidth, pageHeight))
  // Each control has a tooltip; hundreds would slow every selection, so only
  // the pages near the view have theirs.
  const showControls = nearView || focusWithin

  // A control hidden or removed under focus may send no blur. Check again as
  // the page leaves the view, where a stale flag would keep its controls.
  useEffect(() => {
    if (!nearView && focusWithin && !itemRef.current?.contains(document.activeElement)) {
      setFocusWithin(false)
    }
  }, [focusWithin, nearView])

  return (
    <li
      className="relative"
      data-flip-key={flipKey}
      onBlur={(event) => {
        // Leaving the window blurs with no `relatedTarget` but keeps
        // `activeElement`, and focus comes back to the same control.
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !event.currentTarget.contains(document.activeElement)
        ) {
          setFocusWithin(false)
        }
      }}
      onFocus={() => setFocusWithin(true)}
      ref={itemRef}
    >
      {/* Faded rather than hidden: a hidden button would give up its focus,
          and the flow's keys with it. */}
      <div className={cn(hole && "opacity-0")}>
        <PdfThumbnail
          caption={caption}
          documentId={documentId}
          frame={frame === null ? undefined : { height: frame, width: frame }}
          intrinsicRotation={intrinsicRotation}
          isCurrent={isCurrent}
          isCut={isCut}
          isSelected={isSelected}
          label={label}
          mark={signed ? <PageSignatureMark /> : undefined}
          onSelect={onSelect}
          overlay={
            showControls ? (
              <PageControls
                caption={caption}
                deleteDisabled={deleteDisabled}
                isSelected={isSelected}
                itemKey={pageNumber}
                onAction={onAction}
              />
            ) : null
          }
          pageHeight={pageHeight}
          pageNumber={pageNumber}
          pageWidth={pageWidth}
          parkKey={flipKey}
          parked={parked}
          renderEpoch={renderEpoch}
          retainBitmap={nearView}
          rotation={rotation}
        />
      </div>
      {showControls ? (
        <>
          <InsertGap
            frame={frame}
            label={t("pageEdit.insertBefore", { pageNumber: caption })}
            onInsert={() => onInsertBlank(pageNumber, "before")}
            side="before"
          />
          {isLast ? (
            <InsertGap
              frame={frame}
              label={t("pageEdit.insertAfter", { pageNumber: caption })}
              onInsert={() => onInsertBlank(pageNumber, "after")}
              side="after"
            />
          ) : null}
        </>
      ) : null}
      {hole ? (
        <DragHole
          height={paper.height}
          top={frame === null ? 0 : (frame - paper.height) / 2}
          width={paper.width}
        />
      ) : null}
    </li>
  )
})
