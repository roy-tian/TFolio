import { useEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForRow,
  exceedsDragThreshold,
  indexAfterMove,
} from "@/lib/pageDrag"

type UseListDragOptions = {
  /** Vertical lists (the default) drop by y; horizontal strips like the tab
      bar by x. Decided once at measurement so the rest is axis-free. */
  axis?: "x" | "y"
  active: boolean
  listRef: RefObject<HTMLElement | null>
  onReorder: (from: number, to: number) => void
  /** Targets that are pressed, not dragged. A row's own buttons by default;
      the tab strip overrides it to the close button alone, its title button
      being the handle. */
  pressOnly?: (target: Element) => boolean
}

const pressedButton = (target: Element) => target.closest("button") !== null

/**
 * Rects, not `offsetTop`, and in the list's scrolled content space — the space
 * `contentCoordinate` answers in — so the two agree whatever the offset parent
 * is. A horizontal strip's cells are normalised into the vertical `{top,
 * height}` shape the drop-gap and way-offset math already speaks.
 */
function measureCells(list: HTMLElement, axis: "x" | "y") {
  const listRect = list.getBoundingClientRect()
  const listStart = axis === "x" ? listRect.left : listRect.top

  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-list-index]"),
    (element) => {
      const rect = element.getBoundingClientRect()

      return axis === "x"
        ? { height: rect.width, top: rect.left - listStart + list.scrollLeft }
        : { height: rect.height, top: rect.top - listStart + list.scrollTop }
    },
  )
}

export type ListDragState = {
  index: number
  gap: number
  grip: { x: number; y: number }
  height: number
  pointer: { x: number; y: number }
  cellOffsets: number[]
  width: number
}

function makeWayOffsets(
  index: number,
  gap: number,
  cells: { height: number; top: number }[],
) {
  const offsets = Array.from({ length: cells.length }, () => 0)
  const destination = indexAfterMove(index, gap)

  if (destination < index) {
    for (let cell = destination; cell < index; cell += 1) {
      offsets[cell] = cells[cell + 1]!.top - cells[cell]!.top
    }
  } else if (destination > index) {
    for (let cell = index + 1; cell <= destination; cell += 1) {
      offsets[cell] = cells[cell - 1]!.top - cells[cell]!.top
    }
  }

  return offsets
}

/**
 * Cells are measured in the list's scrolled content space, not the viewport's,
 * so scrolling mid-drag still answers about the cell under the pointer. The
 * offsets the state carries are along the list's axis; the caller knows which.
 */
export function useListDrag({
  active,
  axis = "y",
  listRef,
  onReorder,
  pressOnly = pressedButton,
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
      cells: { height: number; top: number }[]
      dragging: boolean
      width: number
    } | null = null

    const contentCoordinate = (event: PointerEvent) => {
      const list = listRef.current

      if (!list) {
        return null
      }

      const rect = list.getBoundingClientRect()

      return axis === "x"
        ? event.clientX - rect.left + list.scrollLeft
        : event.clientY - rect.top + list.scrollTop
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

      if (pressOnly(target)) {
        return
      }

      const cell = target.closest("[data-list-index]")

      if (!cell) {
        return
      }

      const index = Number(cell.getAttribute("data-list-index"))

      if (!Number.isInteger(index) || index < 0) {
        return
      }

      const cellRect = cell.getBoundingClientRect()

      // Text and image selection are never an alternate meaning for a press on
      // a reorderable row; WebKit must not start a native text drag here.
      event.preventDefault()

      gesture = {
        cells: measureCells(list, axis),
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
        grip: {
          x: cellRect.left - event.clientX,
          y: cellRect.top - event.clientY,
        },
        height: cellRect.height,
        index,
        pointerId: event.pointerId,
        width: cellRect.width,
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

      const coordinate = contentCoordinate(event)

      if (coordinate === null) {
        return
      }

      const gap = dropGapForRow(coordinate, gesture.cells)

      setDrag({
        cellOffsets: makeWayOffsets(gesture.index, gap, gesture.cells),
        gap,
        grip: gesture.grip,
        height: gesture.height,
        index: gesture.index,
        pointer: { x: event.clientX, y: event.clientY },
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

      const coordinate = contentCoordinate(event)

      if (coordinate === null) {
        return
      }

      const to = indexAfterMove(
        current.index,
        dropGapForRow(coordinate, current.cells),
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
