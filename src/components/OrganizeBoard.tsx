import {
  memo,
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { FilePlus2, Layers, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import { useNearViewport } from "@/hooks/useNearViewport"
import type { OrganizeGroup, OrganizePlan, SourceMap } from "@/lib/organize"
import { exceedsDragThreshold } from "@/lib/pageDrag"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

/** Where a dragged stack would land: before `beforeKey`, or at the end. */
type DropTarget = { beforeKey: number | null; groupId: number }

// A grid of hundreds of pages keeps pixels only a few screens out.
const RETAIN_MARGIN = "1500px 0px"
// Near this close to the scroll box's edge, a drag scrolls it.
const EDGE_SCROLL_BAND = 48
const EDGE_SCROLL_STEP = 14

const noop = () => {}

// A release's click lands within this of the drag's end; a later one is the
// reader's own, even when the drag ended outside the board and sent no click.
const DRAG_CLICK_WINDOW = 300

/**
 * The slot a point is over, measured in the plan rather than the DOM's order:
 * past a page's middle is after it. A page in hand cannot be its own anchor,
 * so the stack lands before the next page that stays.
 */
function dropTargetAt(
  x: number,
  y: number,
  moving: ReadonlySet<number>,
  plan: OrganizePlan,
): DropTarget | null {
  const element = document.elementFromPoint(x, y)
  const section = element?.closest<HTMLElement>("[data-group-id]")
  const group = plan.groups.find(
    (candidate) => candidate.id === Number(section?.dataset.groupId),
  )

  if (!element || !group) {
    return null
  }

  const keys = group.slots.map((slot) => slot.key)
  const cell = element.closest<HTMLElement>("[data-slot-key]")
  let index = keys.length

  if (element.closest("[data-organize-padding]")) {
    index = 0
  } else if (cell) {
    const box = cell.getBoundingClientRect()

    index =
      keys.indexOf(Number(cell.dataset.slotKey)) +
      (x > box.left + box.width / 2 ? 1 : 0)
  }

  return {
    beforeKey: keys.slice(index).find((key) => !moving.has(key)) ?? null,
    groupId: group.id,
  }
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
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [ghost, setGhost] = useState<{ count: number; x: number; y: number } | null>(
    null,
  )
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

  const startDrag = (event: ReactPointerEvent) => {
    const cell = (event.target as Element).closest<HTMLElement>("[data-slot-key]")

    dragEndedAtRef.current = Number.NEGATIVE_INFINITY

    if (event.button !== 0 || !cell || organize.assembling) {
      return
    }

    const key = Number(cell.dataset.slotKey)
    const start = { x: event.clientX, y: event.clientY }
    let moving: ReadonlySet<number> | null = null
    let point = start
    let frame = 0

    const retarget = () => {
      if (moving) {
        setDrop(dropTargetAt(point.x, point.y, moving, planRef.current))
      }
    }
    // While the pointer rests at an edge the box keeps scrolling under it.
    const edgeScroll = () => {
      const box = scrollRef.current

      if (moving && box) {
        const bounds = box.getBoundingClientRect()
        const step =
          point.y < bounds.top + EDGE_SCROLL_BAND
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

        moving = selectionRef.current.has(key) ? selectionRef.current : new Set([key])

        if (!selectionRef.current.has(key)) {
          anchorRef.current = key
          setSelection(moving)
        }

        frame = requestAnimationFrame(edgeScroll)
      }

      setGhost({ count: moving.size, ...point })
      retarget()
    }
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", release)
      document.removeEventListener("pointercancel", cancel)
      document.removeEventListener("keydown", escape)

      if (moving) {
        dragEndedAtRef.current = performance.now()

        const target = dropTargetAt(point.x, point.y, moving, planRef.current)

        if (commit && target) {
          organize.move(moving, target.groupId, target.beforeKey)
        }
      }

      setDrop(null)
      setGhost(null)
    }
    const release = () => finish(true)
    const cancel = () => finish(false)
    const escape = (pressed: KeyboardEvent) => {
      if (pressed.key === "Escape") {
        pressed.preventDefault()
        finish(false)
      }
    }

    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", release)
    document.addEventListener("pointercancel", cancel)
    document.addEventListener("keydown", escape)
  }

  const outputNumber = new Map<number, number>()
  const paddingOf = new Map<number, { height: number; width: number }>()

  pages.forEach((page, index) => {
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
            className="flex min-h-full flex-col gap-8 p-6 pb-24 select-none"
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
          />
        }
      >
        {plan.groups.map((group) => (
          <GroupSection
            cut={cut}
            drop={drop?.groupId === group.id ? drop : null}
            group={group}
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
      {ghost
        ? createPortal(
            <div
              aria-hidden
              className="pointer-events-none fixed z-60 flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-sm shadow-xl ring-1 ring-primary/20"
              style={{ left: ghost.x + 12, top: ghost.y + 12 }}
            >
              <Layers className="size-4 text-muted-foreground" />
              {t("organize.movingPages", { count: ghost.count })}
            </div>,
            document.body,
          )
        : null}
    </ContextMenu>
  )
}

type GroupSectionProps = {
  cut: ReadonlySet<number>
  drop: DropTarget | null
  group: OrganizeGroup
  outputNumber: ReadonlyMap<number, number>
  /** The blank smart padding puts before this file, if any. */
  padding: { height: number; width: number } | undefined
  paperWidth: number
  selection: ReadonlySet<number>
  sources: SourceMap
}

function GroupSection({
  cut,
  drop,
  group,
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
      <h2 className="flex items-baseline gap-2 text-sm">
        <span className="truncate font-medium">{group.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("organize.pageCount", { count: group.slots.length })}
        </span>
      </h2>
      <div className="flex min-h-24 flex-wrap items-end gap-x-6 gap-y-4 rounded-lg">
        {padding && firstNumber !== undefined ? (
          <PaddingCell
            caption={firstNumber - 1}
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
              dropBefore={drop?.beforeKey === slot.key}
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
        {drop && drop.beforeKey === null ? (
          <span
            aria-hidden
            className="w-0.5 self-stretch rounded-full bg-primary"
            data-organize-drop-end
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
  dropBefore,
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
  dropBefore: boolean
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

  return (
    <div className="relative" data-slot-key={slotKey} ref={cellRef}>
      {dropBefore ? (
        <span
          aria-hidden
          className="absolute inset-y-0 -left-3.5 w-0.5 rounded-full bg-primary"
          data-organize-drop-before
        />
      ) : null}
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
          deleteDisabled
          documentId={sourceId}
          intrinsicRotation={intrinsicRotation}
          isCurrent={false}
          isCut={isCut}
          isSelected={isSelected}
          label={label}
          onDelete={noop}
          onOpen={noop}
          onSelect={noop}
          pageHeight={pageHeight}
          pageNumber={pageNumber}
          pageWidth={pageWidth}
          paperWidth={paperWidth}
          renderEpoch={0}
          retainBitmap={nearView}
          rotation={turn}
          selectedCount={0}
          showControls={false}
          surface="organize"
        />
      )}
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
  height,
  paperWidth,
  width,
}: {
  caption: number
  height: number
  paperWidth: number
  width: number
}) {
  const { t } = useTranslation()
  const paper = thumbnailPaper({ height, width }, paperWidth)

  return (
    <div className="flex flex-col items-center" data-organize-padding>
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
