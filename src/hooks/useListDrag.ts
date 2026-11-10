import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

import {
  dropGapForRow,
  exceedsDragThreshold,
  indexAfterMove,
  movesNothing,
  wayOffsets,
} from "@/lib/pageDrag"

type UseListDragOptions = {
  /** Vertical lists (the default) drop by y; horizontal strips like the tab
      bar by x. Decided once at measurement so the rest is axis-free. */
  axis?: "x" | "y"
  active: boolean
  listRef: RefObject<HTMLElement | null>
  /** `moved` lands together, the first of them at `to` and the rest after it. */
  onReorder: (moved: readonly number[], to: number) => void
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

type ClientPoint = { clientX: number; clientY: number }

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
  event: ClientPoint,
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
  /** The pressed cell, whose ghost the pointer carries. */
  index: number
  gap: number
  grip: { x: number; y: number }
  height: number
  /** The cells lifted, the pressed one among them, by ascending index. */
  moving: readonly number[]
  /** The pointer has left the drop area, so this drag is no longer a reorder:
      no insertion gap is shown and the release goes to `onDropOutside`. */
  outside: boolean
  pointer: { x: number; y: number }
  cellOffsets: number[]
  width: number
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
  const remeasureRef = useRef<(() => void) | null>(null)
  // Read through refs so an owner re-render mid-gesture cannot resubscribe the
  // listeners and drop the gesture in flight.
  const onReorderRef = useRef(onReorder)
  const onDropOutsideRef = useRef(onDropOutside)

  onReorderRef.current = onReorder
  onDropOutsideRef.current = onDropOutside

  useEffect(() => {
    if (!active) {
      setDrag(null)
      return
    }

    type Gesture = {
      /** The pressed cell's offset into the list as pressed, which it keeps. */
      anchor: number
      cell: HTMLElement | null
      pointerId: number
      index: number
      from: { x: number; y: number }
      grip: { x: number; y: number }
      height: number
      cells: { height: number; top: number }[]
      dragging: boolean
      /** Where the pointer last was, for a re-measure to answer about. */
      last: ClientPoint
      moving: readonly number[]
      /** The cells predate the owner's drag layout — a list that folds rows
          away while dragging — so none may make way until they are measured
          again after the commit that started the drag. */
      stale: boolean
      /** Takes back the padding `hold` gave the list, if it gave any. */
      unpad: (() => void) | null
      width: number
    }

    let gesture: Gesture | null = null

    const contentCoordinate = (event: ClientPoint) => {
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
      gesture?.unpad?.()
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

      const cells = measureCells(list, axis)

      gesture = {
        anchor: cells[index]!.top - (axis === "x" ? list.scrollLeft : list.scrollTop),
        cell: cell instanceof HTMLElement ? cell : null,
        cells,
        dragging: false,
        from: { x: event.clientX, y: event.clientY },
        grip: {
          x: cellRect.left - event.clientX,
          y: cellRect.top - event.clientY,
        },
        height: cellRect.height,
        index,
        last: event,
        moving: [index],
        pointerId: event.pointerId,
        stale: false,
        unpad: null,
        width: cellRect.width,
      }
    }

    /**
     * The owner's drag layout may move the pressed cell — a list folding
     * rows away above it — so the list scrolls to keep it under
     * the pointer, and pads itself where scrolling cannot reach: a drag that
     * hardly moved still drops where it began.
     */
    const hold = (list: HTMLElement, current: Gesture) => {
      const scroll = axis === "x" ? "scrollLeft" : "scrollTop"
      const drift = () =>
        measureCells(list, axis)[current.index]!.top - list[scroll] - current.anchor

      list[scroll] += drift()

      const left = drift()

      if (Math.abs(left) < 1) {
        return
      }

      const side =
        left < 0
          ? axis === "x" ? "paddingLeft" : "paddingTop"
          : axis === "x" ? "paddingRight" : "paddingBottom"
      const inline = list.style[side]
      const padding = Number.parseFloat(getComputedStyle(list)[side]) || 0

      list.style[side] = `${padding + Math.abs(left)}px`
      current.unpad = () => {
        list.style[side] = inline
      }

      if (left > 0) {
        list[scroll] += left
      }
    }

    const show = (current: Gesture) => {
      const coordinate = contentCoordinate(current.last)

      if (coordinate === null) {
        return
      }

      const dropArea = dropAreaRef?.current ?? listRef.current
      const outside =
        onDropOutsideRef.current !== undefined &&
        dropArea !== null &&
        outsideElement(current.last, dropArea)
      // Outside the drop area there is no gap to point at: the neighbours come
      // home, and the release answers to `onDropOutside` instead.
      const still = outside || current.stale
      const gap = still ? current.index : dropGapForRow(coordinate, current.cells)

      setDrag({
        cellOffsets: still
          ? Array.from({ length: current.cells.length }, () => 0)
          : wayOffsets(current.moving, indexAfterMove(current.moving, gap), current.cells),
        gap,
        grip: current.grip,
        height: current.height,
        index: current.index,
        moving: current.moving,
        outside,
        pointer: { x: current.last.clientX, y: current.last.clientY },
        width: current.width,
      })
    }

    // Untransformed: a stale gesture has let nothing make way.
    remeasureRef.current = () => {
      const list = listRef.current

      if (gesture?.stale && list) {
        gesture.stale = false
        hold(list, gesture)
        gesture.cells = measureCells(list, axis)
        show(gesture)
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
        gesture.stale = true

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
      gesture.last = event
      show(gesture)
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      const current = gesture

      gesture = null
      setDrag(null)

      // Only once the drop is read: its gap was measured with the padding in.
      try {
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
        const list = listRef.current

        if (coordinate === null || !list) {
          return
        }

        // Let go before the owner's drag layout was measured: the list as it
        // stands now is the one the pointer was over.
        if (current.stale) {
          current.cells = measureCells(list, axis)
        }

        const to = indexAfterMove(
          current.moving,
          dropGapForRow(coordinate, current.cells),
        )

        if (!movesNothing(current.moving, to)) {
          onReorderRef.current(current.moving, to)
        }
      } finally {
        current.unpad?.()
      }
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      gesture.unpad?.()
      gesture = null
      setDrag(null)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointermove", handlePointerMove)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      gesture?.unpad?.()
      remeasureRef.current = null
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointermove", handlePointerMove)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [active, axis, dropAreaRef, listRef])

  const dragging = drag !== null

  // After the commit that started the drag, which is the one the owner's drag
  // layout landed in, and before it paints.
  useLayoutEffect(() => {
    if (dragging) {
      remeasureRef.current?.()
    }
  }, [dragging])

  return { drag }
}
