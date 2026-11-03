import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { FilePlus2, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import {
  DragHole,
  landingBox,
  liftGhost,
  PageDragGhost,
  type PageDragGhostHandle,
  type PageDragGhostState,
} from "@/components/PageDragGhost"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useFlipLayout } from "@/hooks/useFlipLayout"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import { useNearViewport } from "@/hooks/useNearViewport"
import {
  moveSlots,
  outputPages,
  type OrganizeGroup,
  type OrganizePlan,
  type OutputPage,
  type SourceMap,
} from "@/lib/organize"
import { exceedsDragThreshold, flowCellAt } from "@/lib/pageDrag"
import { dimensionsForRotation } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

/** Where a dragged stack would land: before `beforeKey`, or at the end. */
type DropTarget = { beforeKey: number | null; groupId: number }

type BoardDrag = {
  /** The plan the drag started on: any edit landing under it, the drop's own
      included, ends the preview. */
  basis: OrganizePlan
  moving: ReadonlySet<number>
  /** Null while the pointer is beside the board: every page stands where it was. */
  target: DropTarget | null
}

// A grid of hundreds of pages keeps pixels only a few screens out.
const RETAIN_MARGIN = "1500px 0px"
// Near this close to the scroll box's edge, a drag scrolls it.
const EDGE_SCROLL_BAND = 48
const EDGE_SCROLL_STEP = 14

const noop = () => {}

// A release's click lands within this of the drag's end; a later one is the
// reader's own, even when the drag ended outside the board and sent no click.
const DRAG_CLICK_WINDOW = 300
const PAPER = "[data-thumbnail-page], [data-organize-blank]"
const NO_HOLES: ReadonlySet<number> = new Set()

const sameTarget = (left: DropTarget | null, right: DropTarget | null) =>
  left?.groupId === right?.groupId && left?.beforeKey === right?.beforeKey

/**
 * Where the stack lands for a point over the board as laid out now — with the
 * stack where it last landed, so read through `offset*`, past the slides. Over
 * its own holes, or between two files, the landing stays `current`: the pages
 * slide under a still pointer and must not be chased. Beside the board there
 * is none. A page in hand cannot be an anchor, so the stack lands before the
 * next page that stays.
 */
function boardTargetAt(
  point: { x: number; y: number },
  board: HTMLElement,
  view: HTMLElement,
  moving: ReadonlySet<number>,
  current: DropTarget | null,
): DropTarget | null {
  const bounds = view.getBoundingClientRect()

  if (point.x < bounds.left || point.x > bounds.right) {
    return null
  }

  const origin = board.getBoundingClientRect()
  const x = point.x - origin.left
  const y = point.y - origin.top

  for (const section of board.querySelectorAll<HTMLElement>("[data-group-id]")) {
    if (y < section.offsetTop) {
      break
    }

    if (y > section.offsetTop + section.offsetHeight) {
      continue
    }

    const groupId = Number(section.dataset.groupId)
    const flow = section.querySelector<HTMLElement>("[data-organize-flow]")
    const cells = Array.from(
      (flow?.children ?? []) as HTMLCollectionOf<HTMLElement>,
    ).filter(
      (cell) =>
        cell.dataset.slotKey !== undefined || cell.dataset.organizePadding !== undefined,
    )
    const keys = cells.flatMap((cell) =>
      cell.dataset.slotKey === undefined ? [] : [Number(cell.dataset.slotKey)],
    )
    const stayingFrom = (index: number) =>
      keys.slice(index).find((key) => !moving.has(key)) ?? null

    // Over the file's name: in at its start, right beneath it.
    if (!flow || y < flow.offsetTop) {
      return { beforeKey: stayingFrom(0), groupId }
    }

    const hit = flowCellAt(
      { x, y },
      cells.map((cell) => ({
        height: cell.offsetHeight,
        left: cell.offsetLeft,
        top: cell.offsetTop,
        width: cell.offsetWidth,
      })),
    )
    const cell = hit ? cells[hit.index]! : undefined

    if (!hit || !cell) {
      return { beforeKey: null, groupId }
    }

    // The padding blank stands ahead of the file's first page.
    if (cell.dataset.slotKey === undefined) {
      return { beforeKey: stayingFrom(0), groupId }
    }

    const key = Number(cell.dataset.slotKey)

    if (moving.has(key)) {
      return current
    }

    return {
      beforeKey: hit.after ? stayingFrom(keys.indexOf(key) + 1) : key,
      groupId,
    }
  }

  return current
}

type OrganizeBoardProps = {
  organize: OrganizeWorkspace
  paperWidth: number
  scrollRef: RefObject<HTMLElement | null>
}

/** The new document's pages, grouped under the files they come from. */
export function OrganizeBoard({ organize, paperWidth, scrollRef }: OrganizeBoardProps) {
  const { t } = useTranslation()
  const { cut, pages, plan, selection, setSelection, sources } = organize
  const anchorRef = useRef<number | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<BoardDrag | null>(null)
  // By slot key: a hole outlives the drop's commit until the ghost has
  // settled into it.
  const [holes, setHoles] = useState(NO_HOLES)
  const [ghost, setGhost] = useState<PageDragGhostState | null>(null)
  const [landingKey, setLandingKey] = useState<number | null>(null)
  const ghostRef = useRef<PageDragGhostHandle>(null)
  // From a release until the ghost has landed, a press is no drag.
  const settlingRef = useRef(false)
  const { prime } = useFlipLayout(boardRef, drag !== null || ghost !== null)
  const shownPlan =
    drag?.basis === plan && drag.target
      ? moveSlots(plan, drag.moving, drag.target.groupId, drag.target.beforeKey)
      : plan
  // The preview numbers and pads pages as the drop would.
  const shownPages: OutputPage[] =
    shownPlan === plan ? pages : outputPages(shownPlan, sources)
  const [menuKeys, setMenuKeys] = useState<ReadonlySet<number>>(() => new Set())
  // The pages a right-click is over, read when Base UI asks to open: it opens
  // on any press inside the trigger, and off every page there is no menu.
  const pressedKeysRef = useRef<ReadonlySet<number> | null>(null)
  // A drag ends in a click on whatever was under the release; that click is
  // the drag's, not a choice of page. Recency, not a flag, so a release that
  // sent no click here cannot swallow the next one.
  const dragEndedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const planRef = useRef(plan)
  const selectionRef = useRef(selection)

  planRef.current = plan
  selectionRef.current = selection

  const select = useCallback(
    (key: number, { range, toggle }: SelectionModifiers) => {
      const order = planRef.current.groups.flatMap((group) =>
        group.slots.map((slot) => slot.key),
      )
      const anchor = anchorRef.current

      if (range && anchor !== null && order.includes(anchor)) {
        const from = order.indexOf(anchor)
        const to = order.indexOf(key)

        setSelection(new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)))
        return
      }

      anchorRef.current = key

      if (toggle) {
        const next = new Set(selectionRef.current)

        if (!next.delete(key)) {
          next.add(key)
        }

        setSelection(next)
      } else {
        setSelection(new Set([key]))
      }
    },
    [setSelection],
  )

  // After the release's render, so the hole is where the pages now stand.
  useLayoutEffect(() => {
    const board = boardRef.current

    if (landingKey === null || !board) {
      return
    }

    const box = landingBox(
      board,
      board.querySelector(`[data-slot-key="${landingKey}"]`),
      PAPER,
      scrollRef.current,
    )

    void Promise.resolve(ghostRef.current?.land(box))
      .catch(() => {})
      .then(() => {
        settlingRef.current = false
        setHoles(NO_HOLES)
        setGhost(null)
        setDrag(null)
        setLandingKey(null)
      })
  }, [landingKey])

  const startDrag = (event: ReactPointerEvent) => {
    const cell = (event.target as Element).closest<HTMLElement>("[data-slot-key]")
    const paper = cell?.querySelector<HTMLElement>(PAPER)
    const board = boardRef.current

    dragEndedAtRef.current = Number.NEGATIVE_INFINITY

    if (
      event.button !== 0 ||
      !cell ||
      !paper ||
      !board ||
      organize.assembling ||
      settlingRef.current
    ) {
      return
    }

    const key = Number(cell.dataset.slotKey)
    const basis = planRef.current
    const start = { x: event.clientX, y: event.clientY }
    let moving: ReadonlySet<number> | null = null
    let target: DropTarget | null = null
    let point = start
    let frame = 0

    const retarget = () => {
      const view = scrollRef.current

      if (!moving || !view) {
        return
      }

      const next =
        planRef.current === basis
          ? boardTargetAt(point, board, view, moving, target)
          : null

      if (!sameTarget(next, target)) {
        target = next
        setDrag({ basis, moving, target })
      }
    }
    // While the pointer rests at an edge the box keeps scrolling under it.
    const edgeScroll = () => {
      const box = scrollRef.current

      if (moving && box) {
        const bounds = box.getBoundingClientRect()
        const step =
          point.x < bounds.left || point.x > bounds.right
            ? 0
            : point.y < bounds.top + EDGE_SCROLL_BAND
              ? -EDGE_SCROLL_STEP
              : point.y > bounds.bottom - EDGE_SCROLL_BAND
                ? EDGE_SCROLL_STEP
                : 0

        if (step !== 0) {
          box.scrollBy({ top: step })
          retarget()
        }
      }

      frame = requestAnimationFrame(edgeScroll)
    }
    const move = (moved: PointerEvent) => {
      point = { x: moved.clientX, y: moved.clientY }

      if (!moving) {
        if (!exceedsDragThreshold(start, point)) {
          return
        }

        const chosen = selectionRef.current.has(key)
        const lifted = chosen ? selectionRef.current : new Set([key])
        const group = basis.groups.find((candidate) =>
          candidate.slots.some((slot) => slot.key === key),
        )
        const slots = group?.slots ?? []

        moving = lifted

        if (!chosen) {
          anchorRef.current = key
          setSelection(lifted)
        }

        // The stack gathers where the pressed page stands.
        target = group
          ? {
              beforeKey:
                slots
                  .slice(slots.findIndex((slot) => slot.key === key) + 1)
                  .find((slot) => !lifted.has(slot.key))?.key ?? null,
              groupId: group.id,
            }
          : null

        prime()
        setHoles(lifted)
        setDrag({ basis, moving, target })
        setGhost(liftGhost(paper, lifted.size, start, point, t("organize.blankPage")))
        frame = requestAnimationFrame(edgeScroll)
      }

      ghostRef.current?.moveTo(point)
      retarget()
    }
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", release)
      document.removeEventListener("pointercancel", cancel)
      document.removeEventListener("keydown", escape, true)

      if (!moving) {
        return
      }

      dragEndedAtRef.current = performance.now()

      if (commit) {
        retarget()
      }

      settlingRef.current = true

      // The drop commits the very plan the preview shows; anything else puts
      // the pages back where they were, and the ghost with them.
      if (commit && target && planRef.current === basis) {
        organize.move(moving, target.groupId, target.beforeKey)
      } else {
        setDrag({ basis, moving, target: null })
      }

      setLandingKey(key)
    }
    const release = (released: PointerEvent) => {
      point = { x: released.clientX, y: released.clientY }
      finish(true)
    }
    const cancel = () => finish(false)
    const escape = (pressed: KeyboardEvent) => {
      // A press not yet a drag leaves Esc to its usual owners.
      if (pressed.key === "Escape" && moving) {
        // Ahead of the selection's and the clipboard's own Esc: this one ends
        // the drag and nothing else.
        pressed.preventDefault()
        pressed.stopPropagation()
        finish(false)
      }
    }

    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", release)
    document.addEventListener("pointercancel", cancel)
    document.addEventListener("keydown", escape, true)
  }

  const outputNumber = new Map<number, number>()
  const paddingOf = new Map<number, { height: number; width: number }>()

  shownPages.forEach((page, index) => {
    if (page.kind === "slot") {
      outputNumber.set(page.slot.key, index + 1)
    } else {
      paddingOf.set(page.groupId, page)
    }
  })

  return (
    <ContextMenu
      onOpenChange={(open) => {
        setMenuKeys((open && pressedKeysRef.current) || new Set())
        pressedKeysRef.current = null
      }}
      open={menuKeys.size > 0}
    >
      <ContextMenuTrigger
        render={
          <div
            // Positioned: the slides and the drop read every cell's place off it.
            className="relative flex min-h-full flex-col gap-8 p-6 pb-24 select-none"
            data-organize-board
            onClick={(event) => {
              if (performance.now() - dragEndedAtRef.current < DRAG_CLICK_WINDOW) {
                dragEndedAtRef.current = Number.NEGATIVE_INFINITY
                return
              }

              const cell = (event.target as Element).closest<HTMLElement>(
                "[data-slot-key]",
              )

              if (cell) {
                select(Number(cell.dataset.slotKey), {
                  range: event.shiftKey,
                  toggle: event.ctrlKey || event.metaKey,
                })
              } else if (!(event.target as Element).closest("button")) {
                setSelection(new Set())
              }
            }}
            onContextMenu={(event) => {
              const cell = (event.target as Element).closest<HTMLElement>(
                "[data-slot-key]",
              )

              // Only a page has a menu; elsewhere the WebView's own stays away.
              if (!cell) {
                event.preventDefault()
                pressedKeysRef.current = null
                return
              }

              const key = Number(cell.dataset.slotKey)
              const chosen = selection.has(key) ? selection : new Set([key])

              if (!selection.has(key)) {
                anchorRef.current = key
                setSelection(chosen)
              }

              pressedKeysRef.current = chosen
            }}
            onPointerDown={startDrag}
            ref={boardRef}
          />
        }
      >
        {shownPlan.groups.map((group) => (
          <GroupSection
            cut={cut}
            group={group}
            holes={holes}
            key={group.id}
            outputNumber={outputNumber}
            padding={paddingOf.get(group.id)}
            paperWidth={paperWidth}
            selection={selection}
            sources={sources}
          />
        ))}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-action="organize-rotate"
          onClick={() => organize.rotate(menuKeys, 90)}
        >
          <RotateCw />
          {t("pageEdit.rotate", { count: menuKeys.size })}
        </ContextMenuItem>
        <ContextMenuItem
          data-action="organize-rotate-left"
          onClick={() => organize.rotate(menuKeys, 270)}
        >
          <RotateCcw />
          {t("organize.rotateLeft", { count: menuKeys.size })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-action="organize-cut"
          onClick={() => organize.cutSelection()}
        >
          <Scissors />
          {t("pageEdit.cut", { count: menuKeys.size })}
        </ContextMenuItem>
        <ContextMenuItem
          data-action="organize-blank-before"
          onClick={() => organize.insertBlankAt(menuKeys, "before")}
        >
          <FilePlus2 />
          {t("organize.insertBlankBefore")}
        </ContextMenuItem>
        <ContextMenuItem
          data-action="organize-blank-after"
          onClick={() => organize.insertBlankAt(menuKeys, "after")}
        >
          <FilePlus2 />
          {t("organize.insertBlankAfter")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-action="organize-delete"
          onClick={() => organize.remove(menuKeys)}
          variant="destructive"
        >
          <Trash2 />
          {t("pageEdit.delete", { count: menuKeys.size })}
        </ContextMenuItem>
      </ContextMenuContent>
      {ghost ? (
        <PageDragGhost
          count={ghost.count}
          grip={ghost.grip}
          key={ghost.id}
          paper={ghost.paper}
          point={ghost.point}
          ref={ghostRef}
        />
      ) : null}
    </ContextMenu>
  )
}

type GroupSectionProps = {
  cut: ReadonlySet<number>
  group: OrganizeGroup
  /** Slots in hand: their places show where they will land. */
  holes: ReadonlySet<number>
  outputNumber: ReadonlyMap<number, number>
  /** The blank smart padding puts before this file, if any. */
  padding: { height: number; width: number } | undefined
  paperWidth: number
  selection: ReadonlySet<number>
  sources: SourceMap
}

function GroupSection({
  cut,
  group,
  holes,
  outputNumber,
  padding,
  paperWidth,
  selection,
  sources,
}: GroupSectionProps) {
  const { t } = useTranslation()
  const firstNumber = group.slots[0] ? outputNumber.get(group.slots[0].key) : undefined

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
        className="flex min-h-24 flex-wrap items-end gap-x-6 gap-y-4 rounded-lg"
        data-organize-flow
      >
        {padding && firstNumber !== undefined ? (
          <PaddingCell
            caption={firstNumber - 1}
            groupId={group.id}
            height={padding.height}
            paperWidth={paperWidth}
            width={padding.width}
          />
        ) : null}
        {group.slots.map((slot) => {
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
              pageHeight={page?.height ?? 0}
              pageNumber={slot.kind === "page" ? slot.pageNumber : 0}
              pageWidth={page?.width ?? 0}
              paperWidth={paperWidth}
              slotKey={slot.key}
              sourceId={slot.kind === "page" ? slot.sourceId : -1}
              turn={slot.kind === "page" ? slot.turn : 0}
            />
          )
        })}
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
  isSelected,
  label,
  pageHeight,
  pageNumber,
  pageWidth,
  paperWidth,
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
  isSelected: boolean
  label: string
  pageHeight: number
  pageNumber: number
  pageWidth: number
  paperWidth: number
  slotKey: number
  sourceId: number
  turn: number
}) {
  const cellRef = useRef<HTMLDivElement>(null)
  const nearView = useNearViewport(cellRef, RETAIN_MARGIN)
  const paper = thumbnailPaper(
    sourceId < 0
      ? { height: blankHeight, width: blankWidth }
      : dimensionsForRotation(turn, pageWidth, pageHeight),
    paperWidth,
  )

  return (
    <div
      className="relative"
      data-flip-key={`s${slotKey}`}
      data-slot-key={slotKey}
      ref={cellRef}
    >
      {/* Faded rather than hidden: a hidden button would give up its focus. */}
      <div className={cn(hole && "opacity-0")}>
        {sourceId < 0 ? (
          <BlankPaper
            caption={caption}
            height={blankHeight}
            isCut={isCut}
            isSelected={isSelected}
            label={label}
            paperWidth={paperWidth}
            width={blankWidth}
          />
        ) : (
          <PdfThumbnail
            caption={caption}
            documentId={sourceId}
            intrinsicRotation={intrinsicRotation}
            isCurrent={false}
            isCut={isCut}
            isSelected={isSelected}
            label={label}
            onOpen={noop}
            onSelect={noop}
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
      {hole ? <DragHole height={paper.height} width={paper.width} /> : null}
    </div>
  )
})

function BlankPaper({
  caption,
  height,
  isCut,
  isSelected,
  label,
  paperWidth,
  width,
}: {
  caption: number
  height: number
  isCut: boolean
  isSelected: boolean
  label: string
  paperWidth: number
  width: number
}) {
  const paper = thumbnailPaper({ height, width }, paperWidth)

  return (
    <div className={cn("flex flex-col items-center", isCut && "opacity-45")}>
      <button
        aria-label={label}
        aria-pressed={isSelected}
        className={cn(
          "grid place-items-center bg-white text-xs text-zinc-400 shadow-md ring-1 ring-black/10 outline-none hover:ring-2 hover:ring-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50",
          isSelected &&
            "ring-2 ring-primary ring-offset-2 ring-offset-zinc-200/70 hover:ring-primary dark:ring-offset-zinc-950",
        )}
        data-organize-blank
        style={{ height: paper.height, width: paper.width }}
        type="button"
      >
        {label}
      </button>
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
  const paper = thumbnailPaper({ height, width }, paperWidth)

  return (
    <div
      className="flex flex-col items-center"
      data-flip-key={`p${groupId}`}
      data-organize-padding
    >
      <HintTooltip label={t("organize.padding")}>
        <div
          aria-label={t("organize.padding")}
          className="rounded-sm border-2 border-dashed border-muted-foreground/40"
          role="img"
          style={{ height: paper.height, width: paper.width }}
        />
      </HintTooltip>
      <span
        className="flex items-end font-mono text-xs text-muted-foreground/70 tabular-nums"
        style={{ height: THUMBNAIL_CAPTION_HEIGHT }}
      >
        {caption}
      </span>
    </div>
  )
}
