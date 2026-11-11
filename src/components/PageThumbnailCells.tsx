import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PaddingDismiss } from "@/components/PaddingDismiss"
import { PageControls, type PageActionHandler } from "@/components/PageCardControls"
import { DragHole } from "@/components/PageDragGhost"
import { HintTooltip } from "@/components/HintTooltip"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { PageSignatureMark } from "@/components/SignatureBadge"
import { useNearViewport } from "@/hooks/useNearViewport"
import { usePagesDrop, usePagesDropPoint } from "@/hooks/usePagesDrop"
import type { CarriedPages } from "@/lib/pageCarry"
import { flowCells, flowLanding, pointInColumn } from "@/lib/pageDrag"
import type { ParkedPreviews } from "@/lib/parkedPreviews"
import type { PaddingSheet } from "@/lib/padding"
import { dimensionsForRotation } from "@/lib/pdf"
import { THUMBNAIL_GRID_GAP } from "@/lib/sidebar"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"

/** How pages lie: down the sidebar, or across the main area as a grid. */
export type PageThumbnailsLayout = "column" | "grid"

/** Where files let go at `point` go among `flow`'s pages: the count of pages
    before them, the page count past the last, or null with no pages. */
export function fileDropSlot(flow: HTMLElement, point: { x: number; y: number }) {
  return flowLanding(pointInColumn(flow, point), flowCells(flow, () => false), null)
}

/** While a file drag offers the pages, an edge around them and, under the
    pointer, a bar where the files would go. */
export function PagesDropTarget({
  flowRef,
  layout,
}: {
  flowRef: RefObject<HTMLOListElement | null>
  layout: PageThumbnailsLayout
}) {
  const { t } = useTranslation()
  const drop = usePagesDrop()

  if (!drop) {
    return null
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-1 z-10 flex justify-center rounded-xl border-2 border-dashed",
        drop === "over" ? "border-primary/70" : "border-muted-foreground/40",
      )}
      data-over={drop === "over" ? "" : undefined}
      data-testid="pages-drop"
    >
      {/* Across the grid this is all a drag is told about the pages, so it
          is said at the size of what it lies over. */}
      <p
        className={cn(
          "mt-2 h-fit rounded-full bg-background/95 font-medium shadow-sm",
          layout === "grid" ? "px-4 py-1.5 text-sm" : "px-3 py-1 text-xs",
        )}
      >
        {t("sidebar.dropFiles")}
      </p>
      {drop === "over" ? <DropMarker flowRef={flowRef} layout={layout} /> : null}
    </div>
  )
}

/** The bar between the pages the files would go between, drawn over the flow
    in the drop target's own space. Re-rendered by the pointer alone. */
function DropMarker({
  flowRef,
  layout,
}: {
  flowRef: RefObject<HTMLOListElement | null>
  layout: PageThumbnailsLayout
}) {
  const point = usePagesDropPoint()
  const markerRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ height: number; left: number; top: number; width: number } | null>(
    null,
  )

  useLayoutEffect(() => {
    const flow = flowRef.current
    const host = markerRef.current?.parentElement

    if (!flow || !host || !point) {
      setBox(null)
      return
    }

    const cells = Array.from(flow.querySelectorAll<HTMLElement>(":scope > [data-flip-key]"))
    const slot = fileDropSlot(flow, point) ?? cells.length
    const cell = cells[Math.min(slot, cells.length - 1)]

    if (!cell) {
      setBox(null)
      return
    }

    // In the middle of the flow's own gap, off the cell's edge rather than the
    // paper's: a portrait paper stands inside its square, a caption below it.
    const style = getComputedStyle(flow)
    const edge = cell.getBoundingClientRect()
    const paper = (cell.querySelector("[data-thumbnail-page]") ?? cell).getBoundingClientRect()
    const origin = host.getBoundingClientRect()
    const after = slot >= cells.length

    if (layout === "grid") {
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
  }, [flowRef, layout, point])

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

/** A blank page's way in, in the gap beside a grid cell: shown under the
    pointer or the keyboard's focus only, since a row of plus signs would
    crowd the pages. */
function InsertGap({
  frame,
  label,
  onInsert,
  side,
}: {
  frame: number
  label: string
  onInsert: () => void
  side: "before" | "after"
}) {
  return (
    <div
      className="absolute top-0 z-10 grid place-items-center in-data-[pages-dragging]:hidden"
      data-page-control
      style={{
        [side === "before" ? "left" : "right"]: -THUMBNAIL_GRID_GAP,
        height: frame,
        width: THUMBNAIL_GRID_GAP,
      }}
    >
      <HintTooltip label={label}>
        <button
          aria-label={label}
          className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-sm outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 in-data-[pages-busy]:cursor-wait"
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
  layout,
  onAction,
  onInsertBlank,
  onOpen,
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
  /** The square cell of the grid, or null down the sidebar's column. */
  frame: number | null
  /** The page is in hand: its place shows where it will land. */
  hole: boolean
  intrinsicRotation: number
  isCurrent: boolean
  isCut: boolean
  /** The grid's last page also offers a blank after it. */
  isLast: boolean
  isSelected: boolean
  label: string
  layout: PageThumbnailsLayout
  onAction: PageActionHandler
  /** A blank before the page, or after it from the last page's gap. */
  onInsertBlank: (pageNumber: number, side: "before" | "after") => void
  onOpen: (pageNumber: number) => void
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
  // A focused control stays however far the grid scrolls from it: unmounting
  // it would drop keyboard focus back to the start of the document.
  const [focusWithin, setFocusWithin] = useState(false)
  const paper = thumbnailPaper(dimensionsForRotation(rotation, pageWidth, pageHeight))
  // Only the grid edits a page from its own controls, each with a tooltip;
  // hundreds would slow every selection, so only those near the view.
  const showControls = layout === "grid" && (nearView || focusWithin)

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
          onOpen={onOpen}
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
      {showControls && frame !== null ? (
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

