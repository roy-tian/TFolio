import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { PageControls, type PageActionHandler } from "@/components/PageCardControls"
import { DragHole } from "@/components/PageDragGhost"
import { PAPER_CONTROLS_HOST, PdfThumbnail } from "@/components/PdfThumbnail"
import { PageSignatureMark } from "@/components/SignatureBadge"
import { useNearViewport } from "@/hooks/useNearViewport"
import { isOutOfSight, prefersReducedMotion, TURN_MOTION } from "@/lib/motion"
import type { OrganizeGroup, SourceMap } from "@/lib/organize"
import { dimensionsForRotation } from "@/lib/pdf"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

// A grid of hundreds of pages keeps pixels only a few screens out.
const RETAIN_MARGIN = "1500px 0px"
// Between two cells of a row; the insertion line stands in its middle.
const COLUMN_GAP = 24

const noop = () => {}

type Frame = { height: number; width: number }

/** The blank smart padding closes a file with, numbered where it stands. */
export type PaddingPage = { caption: number; height: number; width: number }

/** Every cell is square, as wide and tall as a paper's long side: portrait
    and landscape pages line up in rows and columns, and a turn moves no other
    page, as a cell sized by the board's widest paper would reflow the grid. */
function cellFrame(paperWidth: number): Frame {
  return { height: paperWidth, width: paperWidth }
}

type GroupSectionProps = {
  cut: ReadonlySet<number>
  group: OrganizeGroup
  /** Slots in hand: their places show where they will land. */
  holes: ReadonlySet<number>
  onAction: PageActionHandler
  outputNumber: ReadonlyMap<number, number>
  padding: PaddingPage | undefined
  paperWidth: number
  selection: ReadonlySet<number>
  sources: SourceMap
}

/** One file's pages on the board, under its name. */
export function GroupSection({
  cut,
  group,
  holes,
  onAction,
  outputNumber,
  padding,
  paperWidth,
  selection,
  sources,
}: GroupSectionProps) {
  const { t } = useTranslation()

  return (
    <section
      aria-label={group.title}
      className="flex flex-col gap-3"
      data-group-id={group.id}
    >
      <h2 className="flex items-baseline gap-2 text-sm" data-flip-key={`h${group.id}`}>
        <span className="truncate font-medium">{group.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("organize.pageCount", { count: group.slots.length })}
        </span>
      </h2>
      <div
        className="flex min-h-24 flex-wrap gap-y-4 rounded-lg"
        data-organize-flow
        style={{ columnGap: COLUMN_GAP }}
      >
        {group.slots.map((slot, index) => {
          const source = slot.kind === "page" ? sources.get(slot.sourceId) : undefined
          const page = slot.kind === "page" ? source?.pages[slot.pageNumber - 1] : undefined

          return (
            <SlotCell
              blankHeight={slot.kind === "blank" ? slot.height : 0}
              blankWidth={slot.kind === "blank" ? slot.width : 0}
              caption={outputNumber.get(slot.key) ?? 0}
              hole={holes.has(slot.key)}
              intrinsicRotation={page?.rotation ?? 0}
              isCut={cut.has(slot.key)}
              isLast={index === group.slots.length - 1}
              isSelected={selection.has(slot.key)}
              key={slot.key}
              label={
                slot.kind === "page"
                  ? t("organize.pageLabel", {
                      name: source?.title ?? "",
                      pageNumber: slot.pageNumber,
                    })
                  : t("organize.blankPage")
              }
              onAction={onAction}
              pageHeight={page?.height ?? 0}
              pageNumber={slot.kind === "page" ? slot.pageNumber : 0}
              pageWidth={page?.width ?? 0}
              paperWidth={paperWidth}
              signed={page?.signed === true}
              slotKey={slot.key}
              sourceId={slot.kind === "page" ? slot.sourceId : -1}
              turn={slot.kind === "page" ? slot.turn : 0}
            />
          )
        })}
        {padding ? (
          <PaddingCell
            caption={padding.caption}
            groupId={group.id}
            height={padding.height}
            paperWidth={paperWidth}
            width={padding.width}
          />
        ) : null}
        {group.slots.length === 0 ? (
          <p className="self-center text-sm text-muted-foreground">
            {t("organize.emptyFile")}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Memoised on primitives alone: a fresh object per render would re-render
    every page of the grid on each selection change. */
const SlotCell = memo(function SlotCell({
  blankHeight,
  blankWidth,
  caption,
  hole,
  intrinsicRotation,
  isCut,
  isLast,
  isSelected,
  label,
  onAction,
  pageHeight,
  pageNumber,
  pageWidth,
  paperWidth,
  signed,
  slotKey,
  sourceId,
  turn,
}: {
  blankHeight: number
  blankWidth: number
  caption: number
  hole: boolean
  intrinsicRotation: number
  isCut: boolean
  /** The file's last page, after which only this cell can insert. */
  isLast: boolean
  isSelected: boolean
  label: string
  onAction: PageActionHandler
  pageHeight: number
  pageNumber: number
  pageWidth: number
  paperWidth: number
  signed: boolean
  slotKey: number
  sourceId: number
  turn: number
}) {
  const { t } = useTranslation()
  const cellRef = useRef<HTMLDivElement>(null)
  const nearView = useNearViewport(cellRef, RETAIN_MARGIN)
  // A focused control stays however far the board scrolls from it: unmounting
  // it would drop keyboard focus back to the start of the document.
  const [focusWithin, setFocusWithin] = useState(false)
  // Each control carries a tooltip; hundreds of them would slow every
  // selection, so only cells near the view have any.
  const showControls = nearView || focusWithin

  // A control hidden or removed under focus may send no blur. Check again as
  // the cell leaves the view, where a stale flag would keep its controls.
  useEffect(() => {
    if (!nearView && focusWithin && !cellRef.current?.contains(document.activeElement)) {
      setFocusWithin(false)
    }
  }, [focusWithin, nearView])
  const frame = cellFrame(paperWidth)
  const paper = thumbnailPaper(
    sourceId < 0
      ? { height: blankHeight, width: blankWidth }
      : dimensionsForRotation(turn, pageWidth, pageHeight),
    paperWidth,
  )
  // The white between the paper and its cell's edge, on either side.
  const margin = (frame.width - paper.width) / 2
  const overlay = showControls ? (
    <PageControls
      caption={caption}
      isSelected={isSelected}
      itemKey={slotKey}
      onAction={onAction}
    />
  ) : null

  return (
    <div
      className="relative"
      data-flip-key={`s${slotKey}`}
      data-slot-key={slotKey}
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
      ref={cellRef}
    >
      {/* Faded rather than hidden: a hidden button would give up its focus. */}
      <div className={cn(hole && "opacity-0")}>
        {sourceId < 0 ? (
          <BlankPaper
            caption={caption}
            frame={frame}
            height={blankHeight}
            isCut={isCut}
            isSelected={isSelected}
            label={label}
            overlay={overlay}
            paperWidth={paperWidth}
            width={blankWidth}
          />
        ) : (
          <PdfThumbnail
            animateRotation
            caption={caption}
            documentId={sourceId}
            frame={frame}
            intrinsicRotation={intrinsicRotation}
            isCurrent={false}
            isCut={isCut}
            isSelected={isSelected}
            label={label}
            mark={signed ? <PageSignatureMark /> : undefined}
            onOpen={noop}
            onSelect={noop}
            overlay={overlay}
            pageHeight={pageHeight}
            pageNumber={pageNumber}
            pageWidth={pageWidth}
            paperWidth={paperWidth}
            renderEpoch={0}
            retainBitmap={nearView}
            rotation={turn}
            surface="organize"
          />
        )}
      </div>
      {hole ? (
        <DragHole
          height={paper.height}
          top={(frame.height - paper.height) / 2}
          width={paper.width}
        />
      ) : null}
      {showControls ? (
        <InsertZone
          action="insert-before"
          height={frame.height}
          label={t("pageEdit.insertBefore", { pageNumber: caption })}
          left={-COLUMN_GAP}
          line={COLUMN_GAP / 2}
          onAction={onAction}
          slotKey={slotKey}
          width={COLUMN_GAP + margin}
        />
      ) : null}
      {showControls && isLast ? (
        <InsertZone
          action="insert-after"
          height={frame.height}
          label={t("pageEdit.insertAfter", { pageNumber: caption })}
          left={frame.width - margin}
          line={margin + COLUMN_GAP / 2}
          onAction={onAction}
          slotKey={slotKey}
          width={margin + COLUMN_GAP}
        />
      ) : null}
    </div>
  )
})

/**
 * The white between two pages: under the pointer it shows a line and a +
 * that inserts a blank page there. Only the + acts; a click on the white
 * around it chooses no page.
 */
function InsertZone({
  action,
  height,
  label,
  left,
  line,
  onAction,
  slotKey,
  width,
}: {
  action: "insert-before" | "insert-after"
  /** The cell's frame: the line runs the height of a row's papers. */
  height: number
  label: string
  /** Where the zone starts and how wide it runs, from the cell's left edge. */
  left: number
  /** Where the line stands, from the zone's own left edge. */
  line: number
  onAction: PageActionHandler
  slotKey: number
  width: number
}) {
  return (
    <div
      className="absolute top-0 z-10 [--zone-shown:0] hover:[--zone-shown:1] has-focus-visible:[--zone-shown:1] in-data-[pages-busy]:hidden in-data-[pages-dragging]:hidden"
      data-insert-zone={action}
      data-page-control
      style={{ height, left, width }}
    >
      <span
        className="pointer-events-none absolute top-0 h-full w-0 border-l-2 border-dashed border-primary/60 opacity-(--zone-shown) transition-opacity"
        style={{ left: line - 1 }}
      />
      <HintTooltip label={label}>
        <button
          aria-label={label}
          // Its own hit area, wider than the gap's middle: the pointer that
          // made the + appear is already on it.
          className="absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center outline-none"
          onClick={(event) => onAction(slotKey, action, event.detail === 0)}
          style={{ left: line }}
          type="button"
        >
          <span className="grid size-5 place-items-center rounded-full border border-primary bg-background text-primary opacity-(--zone-shown) shadow-sm transition-opacity">
            <Plus className="size-3" />
          </span>
        </button>
      </HintTooltip>
    </div>
  )
}

function BlankPaper({
  caption,
  frame,
  height,
  isCut,
  isSelected,
  label,
  overlay,
  paperWidth,
  width,
}: {
  caption: number
  frame: Frame
  height: number
  isCut: boolean
  isSelected: boolean
  label: string
  overlay: ReactNode
  paperWidth: number
  width: number
}) {
  const paper = thumbnailPaper({ height, width }, paperWidth)
  const paperRef = useRef<HTMLButtonElement>(null)
  const shownRef = useRef(paper)

  // A blank has nothing to spin: a turn reshapes the sheet, as a page's
  // footprint swaps while it spins.
  useLayoutEffect(() => {
    const before = shownRef.current
    const sheet = paperRef.current

    shownRef.current = paper

    if (
      !sheet ||
      before.width > before.height === paper.width > paper.height ||
      prefersReducedMotion() ||
      isOutOfSight(sheet)
    ) {
      return
    }

    const reshape = sheet.animate(
      [
        { height: `${before.height}px`, width: `${before.width}px` },
        { height: `${paper.height}px`, width: `${paper.width}px` },
      ],
      TURN_MOTION,
    )

    return () => reshape.cancel()
  }, [paper.height, paper.width])

  return (
    <div
      className={cn("flex flex-col items-center", isCut && "opacity-45")}
      data-cut={isCut ? "" : undefined}
    >
      <div
        className="grid place-items-center"
        style={{ height: frame.height, width: frame.width }}
      >
        <div className={cn("relative", overlay && PAPER_CONTROLS_HOST)}>
          <button
            aria-label={label}
            aria-pressed={isSelected}
            className={cn(
              "grid place-items-center bg-white text-xs text-zinc-400 shadow-md ring-1 ring-black/10 outline-none hover:ring-2 hover:ring-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50",
              isSelected &&
                "ring-2 ring-primary ring-offset-2 ring-offset-zinc-200/70 hover:ring-primary dark:ring-offset-zinc-950",
            )}
            data-organize-blank
            ref={paperRef}
            style={{ height: paper.height, width: paper.width }}
            type="button"
          >
            {label}
          </button>
          {overlay}
        </div>
      </div>
      <span
        className="flex items-end font-mono text-xs text-muted-foreground tabular-nums"
        style={{ height: THUMBNAIL_CAPTION_HEIGHT }}
      >
        {caption}
      </span>
    </div>
  )
}

/** The blank smart padding adds: shown where it will stand, not chosen. */
function PaddingCell({
  caption,
  groupId,
  height,
  paperWidth,
  width,
}: {
  caption: number
  groupId: number
  height: number
  paperWidth: number
  width: number
}) {
  const { t } = useTranslation()
  const frame = cellFrame(paperWidth)
  const paper = thumbnailPaper({ height, width }, paperWidth)

  return (
    <div
      className="flex flex-col items-center"
      data-flip-key={`p${groupId}`}
      data-organize-padding
    >
      <div
        className="grid place-items-center"
        style={{ height: frame.height, width: frame.width }}
      >
        <HintTooltip label={t("organize.padding")}>
          <div
            aria-label={t("organize.padding")}
            className="rounded-sm border-2 border-dashed border-muted-foreground/40"
            role="img"
            style={{ height: paper.height, width: paper.width }}
          />
        </HintTooltip>
      </div>
      <span
        className="flex items-end font-mono text-xs text-muted-foreground/70 tabular-nums"
        style={{ height: THUMBNAIL_CAPTION_HEIGHT }}
      >
        {caption}
      </span>
    </div>
  )
}
