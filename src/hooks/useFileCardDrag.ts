import { useEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForPoint,
  exceedsDragThreshold,
  orderAfterMove,
  type CellBox,
} from "@/lib/pageDrag"

type UseFileCardDragOptions = {
  active: boolean
  cardCount: number
  columns: number
  /** The grid the cards are laid out in. */
  gridRef: RefObject<HTMLElement | null>
  /** The cards' new 1-based order, once a drag drops them somewhere new. */
  onReorder: (cardOrder: number[]) => void
}

/** A card drag in progress, for the ghost and the target-gap indicator. */
export type FileCardDragState = {
  /** The 1-based card being dragged. */
  cardPosition: number
  pointer: { x: number; y: number }
  /** The gap the drop would land in: 0 before the first card, n after the last. */
  gap: number
}

/**
 * Drag-to-reorder for the file cards, the same self-drawn pointer gesture the
 * thumbnail grid uses (`usePageDrag`) and sharing its geometry, minus the
 * multi-select a file card has no use for. A card carries a whole file, so its
 * own attribute — not `data-page-number` — keeps page tracking and the page
 * input blind to it.
 */
export function useFileCardDrag({
  active,
  cardCount,
  columns,
  gridRef,
  onReorder,
}: UseFileCardDragOptions): { drag: FileCardDragState | null } {
  const [drag, setDrag] = useState<FileCardDragState | null>(null)
  // Read through refs so an owner re-render mid-gesture cannot resubscribe the
  // listeners and drop the in-flight gesture, as in `usePageDrag`.
  const onReorderRef = useRef(onReorder)
  const columnsRef = useRef(columns)
  const cardCountRef = useRef(cardCount)

  onReorderRef.current = onReorder
  columnsRef.current = columns
  cardCountRef.current = cardCount

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    let gesture: {
      pointerId: number
      cardPosition: number
      from: { x: number; y: number }
      cells: CellBox[]
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
      setDrag(null)

      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      const grid = gridRef.current
      const target = event.target

      if (!grid || !(target instanceof Element) || !grid.contains(target)) {
        return
      }

      const cardElement = target.closest("[data-file-index]")

      if (!cardElement) {
        return
      }

      const cardPosition = Number(cardElement.getAttribute("data-file-index"))

      if (!Number.isInteger(cardPosition) || cardPosition < 1) {
        return
      }

      const gridRect = grid.getBoundingClientRect()
      const cells = Array.from(
        grid.querySelectorAll<HTMLElement>("[data-file-index]"),
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
        cardPosition,
        cells,
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
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

      setDrag({
        cardPosition: gesture.cardPosition,
        gap: dropGapForPoint(point, gesture.cells, columnsRef.current),
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

      const point = gridPoint(event)

      if (!point) {
        return
      }

      const gap = dropGapForPoint(point, current.cells, columnsRef.current)

      onReorderRef.current(
        orderAfterMove([current.cardPosition], gap, cardCountRef.current),
      )
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
  }, [active, gridRef])

  return { drag }
}
