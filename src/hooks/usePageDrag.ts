import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForPoint,
  exceedsDragThreshold,
  orderAfterMove,
  type CellBox,
} from "@/lib/pageDrag"

type UsePageDragOptions = {
  active: boolean
  columns: number
  /** The thumbnail grid element the cells are laid out in. */
  gridRef: RefObject<HTMLElement | null>
  /** May answer with the reorder's own promise; the make-way layout is held
      until it settles. */
  onReorder: (order: number[]) => void | Promise<unknown>
  pageCount: number
  /** Dragging a selected page carries the whole selection with it. */
  selectedPages: ReadonlySet<number>
}

/** A drag in progress, for the ghost and the make-way preview. */
export type PageDragState = {
  /** The cell boxes as they stood when the drag began, in grid coordinates:
      the slots the grid's own pages slide between to open the drop's hole. */
  cells: CellBox[]
  /** The gap the drop would land in: 0 before page 1, n after the last. */
  gap: number
  /** Where the grabbed page's own top-left sits relative to the pointer, so
      the ghost keeps the grip it was picked up by. */
  grip: { x: number; y: number }
  /** The page actually pressed — the one the ghost shows, whatever else in
      the selection travels with it. */
  lead: number
  /** Ascending page numbers travelling with the pointer. */
  pages: number[]
  /** Client coordinates the ghost follows. */
  pointer: { x: number; y: number }
  /** Set once the pointer is up and the reorder is in flight. The pages only
      change when the backend has moved them, so the made way stands until then
      — dropping it here would snap every cell back to the old order for the
      length of that round trip — while the ghost is already gone. */
  released: boolean
}

/**
 * Drag-to-reorder for the thumbnail grid, drawn by hand from pointer events:
 * Tauri's drag-drop handling and WebKitGTK make HTML5 DnD unusable here (the
 * M3 lesson), and a self-drawn drag is also what the e2e suite can drive.
 *
 * A press only becomes a drag past a small movement threshold, which is what
 * keeps single and double click working on the same cells. Cell geometry is
 * measured once at that moment, in grid coordinates; every later move is pure
 * math against the snapshot plus one rect read of the grid itself, and those
 * are settled once a frame rather than once per pointer report.
 */
export function usePageDrag({
  active,
  columns,
  gridRef,
  onReorder,
  pageCount,
  selectedPages,
}: UsePageDragOptions): {
  drag: PageDragState | null
  /** Whether the click now being handled is the tail of a finished drag —
      a release that must not read as a selection click. */
  wasDragClick: () => boolean
} {
  const [drag, setDrag] = useState<PageDragState | null>(null)
  // When the last drag ended, read by the click handlers: the click a drag's
  // release fires arrives within milliseconds and must not change the
  // selection. Judged by recency rather than a cleared-on-pointerdown flag,
  // so a click that never had a press — a synthetic one, as the e2e suite
  // dispatches — cannot be swallowed by a long-finished drag.
  const dragEndedAtRef = useRef(Number.NEGATIVE_INFINITY)
  // The pointer listeners subscribe once per active period and read these
  // through refs, so an owner re-render mid-gesture — an unstable `onReorder`,
  // a resolving edit bumping `pending` — cannot resubscribe them and discard
  // the in-flight `gesture` the closure holds.
  const onReorderRef = useRef(onReorder)
  const columnsRef = useRef(columns)
  const pageCountRef = useRef(pageCount)
  const selectedPagesRef = useRef(selectedPages)

  onReorderRef.current = onReorder
  columnsRef.current = columns
  pageCountRef.current = pageCount
  selectedPagesRef.current = selectedPages

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    // Bumped by every gesture that takes the grid, so a reorder resolving late
    // cannot clear a drag that started after it.
    let release = 0
    // A pointer reports faster than the display refreshes, and every report
    // re-renders a grid that can hold hundreds of cells. Hold the latest
    // position and settle it once a frame: the drop still reads the pointer's
    // own coordinates at release, so only the preview is coalesced.
    let frame = 0
    let latest: { x: number; y: number } | null = null
    let gesture: {
      pointerId: number
      pageNumber: number
      from: { x: number; y: number }
      grip: { x: number; y: number }
      cells: CellBox[]
      /** Set once the threshold is passed; mirrors the `drag` state. */
      dragging: boolean
    } | null = null

    const gridPointAt = (client: { x: number; y: number }) => {
      const grid = gridRef.current

      if (!grid) {
        return null
      }

      const rect = grid.getBoundingClientRect()

      return { x: client.x - rect.left, y: client.y - rect.top }
    }

    const cancelFrame = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }

      latest = null
    }

    /** The pages travelling with the pointer: a grabbed page that is part of
        the selection brings the whole selection with it, any other goes alone. */
    const draggedPages = (pageNumber: number) => {
      const selectedPages = selectedPagesRef.current

      return selectedPages.has(pageNumber)
        ? [...selectedPages].sort((left, right) => left - right)
        : [pageNumber]
    }

    const settleMove = () => {
      frame = 0

      const pointer = latest

      if (!gesture?.dragging || !pointer) {
        return
      }

      const point = gridPointAt(pointer)

      if (!point) {
        return
      }

      setDrag({
        cells: gesture.cells,
        gap: dropGapForPoint(point, gesture.cells, columnsRef.current),
        grip: gesture.grip,
        lead: gesture.pageNumber,
        pages: draggedPages(gesture.pageNumber),
        pointer,
        released: false,
      })
    }

    const handlePointerDown = (event: PointerEvent) => {
      gesture = null
      release += 1
      cancelFrame()
      dragEndedAtRef.current = Number.NEGATIVE_INFINITY
      setDrag(null)

      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      const grid = gridRef.current
      const target = event.target

      if (!grid || !(target instanceof Element) || !grid.contains(target)) {
        return
      }

      const cellElement = target.closest("[data-page-number]")

      if (!cellElement) {
        return
      }

      const pageNumber = Number(cellElement.getAttribute("data-page-number"))

      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return
      }

      // The layout cannot change mid-drag, so one measurement pass here is the
      // whole geometry: cell boxes in the grid's own space stay true however
      // the viewer scrolls underneath the pointer.
      const gridRect = grid.getBoundingClientRect()
      const cells = Array.from(
        grid.querySelectorAll<HTMLElement>("[data-page-number]"),
        (cell) => {
          const rect = cell.getBoundingClientRect()

          return {
            height: rect.height,
            left: rect.left - gridRect.left,
            top: rect.top - gridRect.top,
            width: rect.width,
          }
        },
      )

      const pressed = cellElement.getBoundingClientRect()

      gesture = {
        cells,
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
        grip: {
          x: pressed.left - event.clientX,
          y: pressed.top - event.clientY,
        },
        pageNumber,
        pointerId: event.pointerId,
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      if (!gesture.dragging) {
        if (
          !exceedsDragThreshold(gesture.from, {
            x: event.clientX,
            y: event.clientY,
          })
        ) {
          return
        }

        gesture.dragging = true
      }

      latest = { x: event.clientX, y: event.clientY }

      if (frame === 0) {
        frame = requestAnimationFrame(settleMove)
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      const current = gesture

      gesture = null
      // The release reads the pointer where it actually let go, so a frame
      // still holding an older position has nothing left to say.
      cancelFrame()

      if (!current.dragging) {
        setDrag(null)
        return
      }

      dragEndedAtRef.current = performance.now()

      const point = gridPointAt({ x: event.clientX, y: event.clientY })

      if (!point) {
        setDrag(null)
        return
      }

      const pages = draggedPages(current.pageNumber)
      const gap = dropGapForPoint(point, current.cells, columnsRef.current)

      setDrag({
        cells: current.cells,
        gap,
        grip: current.grip,
        lead: current.pageNumber,
        pages,
        pointer: { x: event.clientX, y: event.clientY },
        released: true,
      })

      // Only this release may clear what it put up: a press that starts a new
      // gesture while the reorder is still in flight owns the grid from then on.
      const token = (release += 1)
      const clear = () => {
        if (token === release) {
          setDrag(null)
        }
      }

      void Promise.resolve(
        onReorderRef.current(orderAfterMove(pages, gap, pageCountRef.current)),
      ).then(clear, clear)
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      gesture = null
      release += 1
      cancelFrame()
      setDrag(null)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointermove", handlePointerMove)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      cancelFrame()
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointermove", handlePointerMove)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [active, gridRef])

  const wasDragClick = useCallback(
    () => performance.now() - dragEndedAtRef.current < 300,
    [],
  )

  return { drag, wasDragClick }
}
