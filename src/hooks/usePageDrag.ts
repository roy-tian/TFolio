import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForPoint,
  exceedsDragThreshold,
  orderAfterMove,
  type CellBox,
  type PageHandoff,
  type PageHandoffPlace,
} from "@/lib/pageDrag"

type UsePageDragOptions = {
  active: boolean
  columns: number
  gridRef: RefObject<HTMLElement | null>
  handoff?: PageHandoff
  /** The page list snapshot: a committed structure edit ends its preview. */
  layoutVersion: object
  /** May answer with the reorder's own promise; the make-way layout is held
      until it settles. */
  onReorder: (order: number[]) => void | Promise<unknown>
  pageCount: number
  selectedPages: ReadonlySet<number>
}

export type PageDragState = {
  layoutVersion: object
  /** The workspace has taken the drag, so this grid shows no landing place and
      commits no reorder — only the ghost goes on. Null while it is its own. */
  away: PageHandoffPlace | null
  /** Cell boxes as they stood when the drag began, in grid coordinates: the
      slots pages slide between, each the whole cell with its row gap. */
  cells: CellBox[]
  gap: number
  grip: { x: number; y: number }
  /** The page actually pressed — the one the ghost shows, whatever else in
      the selection travels with it. */
  lead: number
  pages: number[]
  pointer: { x: number; y: number }
  /** The pointer is up: show every page in its landing slot while the backend
      commits, then discard the offsets together with the old page list. */
  released: boolean
}

/**
 * Hand-drawn from pointer events: Tauri drag-drop handling and WebKitGTK make
 * HTML5 DnD unusable here, and a self-drawn drag is what the e2e suite drives.
 */
export function usePageDrag({
  active,
  columns,
  gridRef,
  handoff,
  layoutVersion,
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
  // When the last drag ended: its release fires a click that must not re-select.
  // Recency, not a flag, so a synthetic press-less click (e2e) is never swallowed.
  const dragEndedAtRef = useRef(Number.NEGATIVE_INFINITY)
  // Listeners bind once per active period and read refs, so an owner re-render
  // mid-gesture cannot resubscribe them and drop the in-flight gesture.
  const onReorderRef = useRef(onReorder)
  const handoffRef = useRef(handoff)
  const columnsRef = useRef(columns)
  const pageCountRef = useRef(pageCount)
  const selectedPagesRef = useRef(selectedPages)
  const layoutVersionRef = useRef(layoutVersion)

  onReorderRef.current = onReorder
  handoffRef.current = handoff
  columnsRef.current = columns
  pageCountRef.current = pageCount
  selectedPagesRef.current = selectedPages
  layoutVersionRef.current = layoutVersion

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    // Bumped by every gesture that takes the grid, so a reorder resolving late
    // cannot clear a drag that started after it.
    let release = 0
    let settling = false
    // Pointer reports outnumber frames and each re-renders a grid of hundreds;
    // settle once a frame — the drop still reads the pointer's own coordinates.
    let frame = 0
    let latest: { x: number; y: number } | null = null
    let gesture: {
      pointerId: number
      pageNumber: number
      from: { x: number; y: number }
      grip: { x: number; y: number }
      cells: CellBox[]
      layoutVersion: object
      /** Read once at the press: the source grid's selection is cleared when
          another document shows, and the block must not shrink mid-flight. */
      pages: number[]
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
        layoutVersion: gesture.layoutVersion,
        away: handoffRef.current?.claim(pointer) ?? null,
        cells: gesture.cells,
        gap: dropGapForPoint(point, gesture.cells, columnsRef.current),
        grip: gesture.grip,
        lead: gesture.pageNumber,
        pages: gesture.pages,
        pointer,
        released: false,
      })
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (settling) {
        return
      }

      gesture = null
      release += 1
      cancelFrame()
      // A second press abandons whatever was in hand — a right-click mid-drag
      // is one — so a tab armed under it must not spring open behind it.
      handoffRef.current?.cancel()
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

      // The paper alone starts a drag; the caption under it and the button over
      // its corner are the cell's, not the page's.
      const paper = target.closest("[data-page-number]")

      if (!paper) {
        return
      }

      const pageNumber = Number(paper.getAttribute("data-page-number"))

      if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        return
      }

      // The whole cell, not the paper inside it: cells tile the grid, so each
      // row is one band and the make-way slide is a plain slot difference.
      const gridRect = grid.getBoundingClientRect()
      const cells = Array.from(
        grid.querySelectorAll<HTMLElement>("[data-page-cell]"),
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

      // The grip is the paper's, so the ghost — which is a paper — stays under
      // the same spot of itself all the way to the drop.
      const pressed = paper.getBoundingClientRect()

      gesture = {
        layoutVersion: layoutVersionRef.current,
        cells,
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
        grip: {
          x: pressed.left - event.clientX,
          y: pressed.top - event.clientY,
        },
        pageNumber,
        pages: draggedPages(pageNumber),
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

      if (!current.dragging || current.layoutVersion !== layoutVersionRef.current) {
        // Including a gesture the grid has outlived: a tab armed under it must
        // not spring open once the pages are no longer in hand.
        handoffRef.current?.cancel()
        setDrag(null)
        return
      }

      dragEndedAtRef.current = performance.now()

      const pointer = { x: event.clientX, y: event.clientY }
      const pages = current.pages
      const handoff = handoffRef.current

      // Asked again where it was actually let go of, as the gap below is: a
      // release the workspace has is its drop, not a reorder here.
      if (handoff?.claim(pointer)) {
        setDrag(null)
        handoff.drop(pointer, pages)
        return
      }

      handoff?.cancel()

      const point = gridPointAt(pointer)

      if (!point) {
        setDrag(null)
        return
      }

      const gap = dropGapForPoint(point, current.cells, columnsRef.current)

      setDrag({
        layoutVersion: current.layoutVersion,
        away: null,
        cells: current.cells,
        gap,
        grip: current.grip,
        lead: current.pageNumber,
        pages,
        pointer,
        released: true,
      })

      // Keep the landing layout until this operation settles. A new gesture
      // must measure the committed grid, so presses wait for this release.
      const token = (release += 1)
      settling = true
      const clear = () => {
        if (token === release) {
          settling = false
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
      handoffRef.current?.cancel()
      setDrag(null)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointermove", handlePointerMove)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      cancelFrame()
      // The grid a drag started in is gone; nothing is left to hand over.
      handoffRef.current?.cancel()
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

  return {
    drag: drag?.layoutVersion === layoutVersion ? drag : null,
    wasDragClick,
  }
}
