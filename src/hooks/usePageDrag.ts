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
  onReorder: (order: number[]) => void
  pageCount: number
  /** Dragging a selected page carries the whole selection with it. */
  selectedPages: ReadonlySet<number>
}

/** A drag in progress, for the ghost and the target-gap indicator. */
export type PageDragState = {
  /** Ascending page numbers travelling with the pointer. */
  pages: number[]
  /** Client coordinates the ghost follows. */
  pointer: { x: number; y: number }
  /** The gap the drop would land in: 0 before page 1, n after the last. */
  gap: number
}

/**
 * Drag-to-reorder for the thumbnail grid, drawn by hand from pointer events:
 * Tauri's drag-drop handling and WebKitGTK make HTML5 DnD unusable here (the
 * M3 lesson), and a self-drawn drag is also what the e2e suite can drive.
 *
 * A press only becomes a drag past a small movement threshold, which is what
 * keeps single and double click working on the same cells. Cell geometry is
 * measured once at that moment, in grid coordinates; every later move is pure
 * math against the snapshot plus one rect read of the grid itself.
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
  // Whether the last pointer sequence was a drag, read by the click handlers:
  // the click a drag's release fires must not change the selection. Cleared on
  // the next press, which happens before that press's own click can fire.
  const dragJustEndedRef = useRef(false)

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    let gesture: {
      pointerId: number
      pageNumber: number
      from: { x: number; y: number }
      cells: CellBox[]
      /** Set once the threshold is passed; mirrors the `drag` state. */
      dragging: boolean
    } | null = null

    const gridPoint = (event: PointerEvent) => {
      const grid = gridRef.current

      if (!grid) {
        return null
      }

      const rect = grid.getBoundingClientRect()

      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const handlePointerDown = (event: PointerEvent) => {
      gesture = null
      dragJustEndedRef.current = false
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

      gesture = {
        cells,
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
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

      const point = gridPoint(event)

      if (!point) {
        return
      }

      const pages = selectedPages.has(gesture.pageNumber)
        ? [...selectedPages].sort((left, right) => left - right)
        : [gesture.pageNumber]

      setDrag({
        gap: dropGapForPoint(point, gesture.cells, columns),
        pages,
        pointer: { x: event.clientX, y: event.clientY },
      })
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      const current = gesture

      gesture = null
      setDrag(null)

      if (!current.dragging) {
        return
      }

      dragJustEndedRef.current = true

      const point = gridPoint(event)

      if (!point) {
        return
      }

      const pages = selectedPages.has(current.pageNumber)
        ? [...selectedPages].sort((left, right) => left - right)
        : [current.pageNumber]
      const gap = dropGapForPoint(point, current.cells, columns)

      onReorder(orderAfterMove(pages, gap, pageCount))
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      gesture = null
      setDrag(null)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointermove", handlePointerMove)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointermove", handlePointerMove)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [active, columns, gridRef, onReorder, pageCount, selectedPages])

  const wasDragClick = useCallback(() => dragJustEndedRef.current, [])

  return { drag, wasDragClick }
}
