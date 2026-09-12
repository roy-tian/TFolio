import { useEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForRow,
  exceedsDragThreshold,
  indexAfterMove,
} from "@/lib/pageDrag"

type UseListDragOptions = {
  active: boolean
  listRef: RefObject<HTMLElement | null>
  onReorder: (from: number, to: number) => void
}

/**
 * Rects, not `offsetTop`, and in the list's scrolled content space — the space
 * `contentY` answers in — so the two agree whatever the offset parent is.
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

export type ListDragState = {
  index: number
  gap: number
  grip: { x: number; y: number }
  height: number
  pointer: { x: number; y: number }
  rowOffsets: number[]
  width: number
}

function makeWayOffsets(
  index: number,
  gap: number,
  rows: { height: number; top: number }[],
) {
  const offsets = Array.from({ length: rows.length }, () => 0)
  const destination = indexAfterMove(index, gap)

  if (destination < index) {
    for (let row = destination; row < index; row += 1) {
      offsets[row] = rows[row + 1]!.top - rows[row]!.top
    }
  } else if (destination > index) {
    for (let row = index + 1; row <= destination; row += 1) {
      offsets[row] = rows[row - 1]!.top - rows[row]!.top
    }
  }

  return offsets
}

/**
 * Rows are measured in the list's scrolled content space, not the viewport's,
 * so scrolling mid-drag still answers about the row under the pointer.
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
      grip: { x: number; y: number }
      height: number
      rows: { height: number; top: number }[]
      dragging: boolean
      width: number
    } | null = null

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

      const rowRect = row.getBoundingClientRect()

      // Text and image selection are never an alternate meaning for a press on
      // a reorderable row; WebKit must not start a native text drag here.
      event.preventDefault()

      gesture = {
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
        grip: {
          x: rowRect.left - event.clientX,
          y: rowRect.top - event.clientY,
        },
        height: rowRect.height,
        index,
        pointerId: event.pointerId,
        rows: measureRows(list),
        width: rowRect.width,
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

      event.preventDefault()

      const y = contentY(event)

      if (y === null) {
        return
      }

      const gap = dropGapForRow(y, gesture.rows)

      setDrag({
        gap,
        grip: gesture.grip,
        height: gesture.height,
        index: gesture.index,
        pointer: { x: event.clientX, y: event.clientY },
        rowOffsets: makeWayOffsets(gesture.index, gap, gesture.rows),
        width: gesture.width,
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

      event.preventDefault()

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
