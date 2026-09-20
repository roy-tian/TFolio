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
  /** Answers a release outside the drop area instead of the clamped reorder.
      Its presence is what switches the gesture over: the insertion preview
      stops at the drop area's edge, and leaving it means the drop went. */
  onDropOutside?: (point: { x: number; y: number }, index: number) => void
  /** The area a release stays a reorder inside — the list itself by default.
      The tab strip passes the whole strip, so its trailing spacer and the
      actions beside the list read as strip rather than as out. */
  dropAreaRef?: RefObject<HTMLElement | null>
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

/** The pointer against an element's viewport rect. Out-of-window coordinates
    answer here too: the platform keeps delivering a held pointer's events to
    the window the press happened in, and the capture below keeps the page
    seeing them. */
function outsideElement(
  event: PointerEvent,
  element: HTMLElement,
): boolean {
  const rect = element.getBoundingClientRect()

  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
}

export type ListDragState = {
  index: number
  gap: number
  grip: { x: number; y: number }
  height: number
  /** The pointer has left the drop area, so this drag is no longer a reorder:
      no insertion gap is shown and the release goes to `onDropOutside`. */
  outside: boolean
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
  onDropOutside,
  dropAreaRef,
}: UseListDragOptions): { drag: ListDragState | null } {
  const [drag, setDrag] = useState<ListDragState | null>(null)
  // Read through refs so an owner re-render mid-gesture cannot resubscribe the
  // listeners and drop the gesture in flight, as in `usePageDrag`.
  const onReorderRef = useRef(onReorder)
  const onDropOutsideRef = useRef(onDropOutside)

  onReorderRef.current = onReorder
  onDropOutsideRef.current = onDropOutside

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    let gesture: {
      cell: HTMLElement | null
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
        cell: cell instanceof HTMLElement ? cell : null,
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

        // Held pointers stay this window's until release on every platform, but
        // only a capture hands the page the events beyond its own viewport —
        // where a strip drag is headed. Taken only now that this is a drag and
        // not a press: a capture taken on the press would retarget the click
        // that follows it onto the cell, and the pressed control would never
        // hear it. Synthetic pointers have none to take.
        if (gesture.cell) {
          try {
            gesture.cell.setPointerCapture(event.pointerId)
          } catch {
            // A dispatched event names no active pointer; the drag tracks it
            // through the document listeners alone, as it did before.
          }
        }
      }

      event.preventDefault()

      const coordinate = contentCoordinate(event)

      if (coordinate === null) {
        return
      }

      const dropArea = dropAreaRef?.current ?? listRef.current
      const outside =
        onDropOutsideRef.current !== undefined &&
        dropArea !== null &&
        outsideElement(event, dropArea)

      // Outside the drop area there is no gap to point at: the neighbours come
      // home, and the release answers to `onDropOutside` instead.
      const gap = outside ? gesture.index : dropGapForRow(coordinate, gesture.cells)

      setDrag({
        cellOffsets: outside
          ? Array.from({ length: gesture.cells.length }, () => 0)
          : makeWayOffsets(gesture.index, gap, gesture.cells),
        gap,
        grip: gesture.grip,
        height: gesture.height,
        index: gesture.index,
        outside,
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

      const dropArea = dropAreaRef?.current ?? listRef.current
      const onDropOutside = onDropOutsideRef.current

      if (
        onDropOutside &&
        dropArea !== null &&
        outsideElement(event, dropArea)
      ) {
        onDropOutside({ x: event.clientX, y: event.clientY }, current.index)
        return
      }

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
  }, [active, dropAreaRef, listRef])

  return { drag }
}
