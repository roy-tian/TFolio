import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { InsertAfterIcon, InsertBeforeIcon } from "@/components/InsertPageIcon"
import {
  boardFrame,
  GroupSection,
  PAGE_CONTROL,
  type PageActionHandler,
} from "@/components/OrganizeGroupSection"
import {
  landingBox,
  liftGhost,
  PageDragGhost,
  type PageDragGhostHandle,
  type PageDragGhostState,
} from "@/components/PageDragGhost"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useFlipLayout } from "@/hooks/useFlipLayout"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import {
  moveSlots,
  outputPages,
  type OrganizePlan,
  type OutputPage,
} from "@/lib/organize"
import { exceedsDragThreshold, flowCellAt } from "@/lib/pageDrag"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"

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

// Near this close to the scroll box's edge, a drag scrolls it.
const EDGE_SCROLL_BAND = 48
const EDGE_SCROLL_STEP = 14

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
  const { cut, insertBlankAt, pages, plan, remove, rotate, selection, setSelection, sources } =
    organize
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
  const frame = useMemo(
    () => boardFrame(shownPages, sources, paperWidth),
    [paperWidth, shownPages, sources],
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

  // Focus would fall back to the top of the document with the page it was
  // on: it goes to the page taking that place, or the one before at the end.
  const focusNeighbour = useCallback((key: number) => {
    const order = planRef.current.groups.flatMap((group) =>
      group.slots.map((slot) => slot.key),
    )
    const at = order.indexOf(key)
    const neighbour = order[at + 1] ?? order[at - 1]

    if (neighbour !== undefined) {
      boardRef.current
        ?.querySelector<HTMLElement>(`[data-slot-key="${neighbour}"] :is(${PAPER})`)
        ?.focus()
    }
  }, [])

  // One page's own controls act on that page alone, chosen or not.
  const act = useCallback<PageActionHandler>(
    (key, action, byKeyboard) => {
      const keys = new Set([key])

      switch (action) {
        case "toggle":
          select(key, { range: false, toggle: true })
          break
        case "rotate-left":
          rotate(keys, 270)
          break
        case "rotate-right":
          rotate(keys, 90)
          break
        case "delete":
          if (byKeyboard) {
            focusNeighbour(key)
          }

          remove(keys)
          break
        case "insert-before":
          insertBlankAt(keys, "before")
          break
        case "insert-after":
          insertBlankAt(keys, "after")
          break
      }
    },
    [focusNeighbour, insertBlankAt, remove, rotate, select],
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
    const pressed = event.target as Element
    const cell = pressed.closest<HTMLElement>("[data-slot-key]")
    const paper = cell?.querySelector<HTMLElement>(PAPER)
    const board = boardRef.current

    dragEndedAtRef.current = Number.NEGATIVE_INFINITY

    if (
      event.button !== 0 ||
      pressed.closest(PAGE_CONTROL) ||
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
            // While files are added or assembled every edit is refused, as the
            // toolbar's disabled buttons say; the pages' own say so by hiding.
            data-organize-busy={organize.adding || organize.assembling ? "" : undefined}
            // Pages under a dragged stack show none of their controls.
            data-organize-dragging={drag !== null || ghost !== null ? "" : undefined}
            onClick={(event) => {
              if (performance.now() - dragEndedAtRef.current < DRAG_CLICK_WINDOW) {
                dragEndedAtRef.current = Number.NEGATIVE_INFINITY
                return
              }

              if ((event.target as Element).closest(PAGE_CONTROL)) {
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
              const target = event.target as Element
              // A gap between two pages belongs to neither.
              const cell = target.closest("[data-insert-zone]")
                ? null
                : target.closest<HTMLElement>("[data-slot-key]")

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
            frame={frame}
            group={group}
            holes={holes}
            key={group.id}
            onAction={act}
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
          <InsertBeforeIcon />
          {t("organize.insertBlankBefore")}
        </ContextMenuItem>
        <ContextMenuItem
          data-action="organize-blank-after"
          onClick={() => organize.insertBlankAt(menuKeys, "after")}
        >
          <InsertAfterIcon />
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
