import { useEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForRow,
  exceedsDragThreshold,
  indexAfterMove,
} from "@/lib/pageDrag"

type UseListDragOptions = {
  active: boolean
  /** The scroll box holding the rows, each carrying `data-list-index`. */
  listRef: RefObject<HTMLElement | null>
  /** Both indices 0-based. Only called for a drop that really moves the row. */
  onReorder: (from: number, to: number) => void
}

/**
 * Each row's top and height in the list's own scrolled content space — the
 * space `contentY` answers in, so the two agree whatever the list's offset
 * parent turns out to be. Measured off the rectangles rather than `offsetTop`,
 * which is relative to whichever ancestor happens to be positioned.
 */
function measureRows(list: HTMLElement) {
  const listTop = list.getBoundingClientRect().top

  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-list-index]"),
    (element) => {
      const rect = element.getBoundingClientRect()

      return { height: rect.height, top: rect.top - listTop + list.scrollTop }
    },
  )
}

/** A row drag in progress, for dimming the row and drawing the drop line. */
export type ListDragState = {
  /** The 0-based row in hand. */
  index: number
  /** Where the drop would land: 0 above the first row, n below the last. */
  gap: number
}

/**
 * Drag-to-reorder for a single-column list — the same self-drawn pointer
 * gesture the thumbnail grid uses (`usePageDrag`), with the geometry a stack of
 * rows needs instead of a grid's: `dropGapForRow` reads the row's own vertical
 * midpoint.
 *
 * Rows are measured in the list's own scrolled content space, not the
 * viewport's, so a list the reader scrolls mid-drag keeps answering about the
 * row under the pointer.
 */
export function useListDrag({
  active,
  listRef,
  onReorder,
}: UseListDragOptions): { drag: ListDragState | null } {
  const [drag, setDrag] = useState<ListDragState | null>(null)
  // Read through a ref so an owner re-render mid-gesture cannot resubscribe the
  // listeners and drop the gesture in flight, as in `usePageDrag`.
  const onReorderRef = useRef(onReorder)

  onReorderRef.current = onReorder

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    let gesture: {
      pointerId: number
      index: number
      from: { x: number; y: number }
      rows: { height: number; top: number }[]
      dragging: boolean
    } | null = null

    /** The pointer's y in the list's own scrolled content space. */
    const contentY = (event: PointerEvent) => {
      const list = listRef.current

      if (!list) {
        return null
      }

      return event.clientY - list.getBoundingClientRect().top + list.scrollTop
    }

    const handlePointerDown = (event: PointerEvent) => {
      gesture = null
      setDrag(null)

      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      const list = listRef.current
      const target = event.target

      if (!list || !(target instanceof Element) || !list.contains(target)) {
        return
      }

      // The row's own buttons — move, remove — are pressed, not dragged.
      if (target.closest("button")) {
        return
      }

      const row = target.closest("[data-list-index]")

      if (!row) {
        return
      }

      const index = Number(row.getAttribute("data-list-index"))

      if (!Number.isInteger(index) || index < 0) {
        return
      }

      gesture = {
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
        index,
        pointerId: event.pointerId,
        rows: measureRows(list),
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

      const y = contentY(event)

      if (y === null) {
        return
      }

      setDrag({ gap: dropGapForRow(y, gesture.rows), index: gesture.index })
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

      const y = contentY(event)

      if (y === null) {
        return
      }

      const to = indexAfterMove(
        current.index,
        dropGapForRow(y, current.rows),
      )

      if (to !== current.index) {
        onReorderRef.current(current.index, to)
      }
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
  }, [active, listRef])

  return { drag }
}
