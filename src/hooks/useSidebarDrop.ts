import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type RefObject,
} from "react"

import { columnEdgeStep } from "@/lib/pageDrag"

/** What a file drag makes of the sidebar on screen: a target that takes the
    dragged files into one document ("over" while the pointer is on it), the
    shown tab's or a new one, or nothing at all. */
export type SidebarDrop = "offered" | "over" | null

export const SidebarDropContext = createContext<SidebarDrop>(null)

export function useSidebarDrop() {
  return useContext(SidebarDropContext)
}

// Apart from the context: a drag reports its point many times a second, and
// only what marks where the files would go needs it.
let dropPoint: { x: number; y: number } | null = null
const dropPointListeners = new Set<() => void>()

function announceDropPoint() {
  dropPointListeners.forEach((listener) => listener())
}

/** Where a file drag over the sidebar's pages or files stands, in CSS pixels;
    null off them, where the files would go to the end. */
export function setSidebarDropPoint(point: { x: number; y: number } | null) {
  if (point?.x === dropPoint?.x && point?.y === dropPoint?.y) {
    return
  }

  dropPoint = point
  announceDropPoint()
}

export function sidebarDropPoint() {
  return dropPoint
}

/** Called as the point moves, and as the list under it scrolls on. */
export function subscribeSidebarDropPoint(listener: () => void) {
  dropPointListeners.add(listener)

  return () => {
    dropPointListeners.delete(listener)
  }
}

export function useSidebarDropPoint() {
  return useSyncExternalStore(subscribeSidebarDropPoint, () => dropPoint)
}

/** While files are held near the top or bottom of one of the sidebar's lists,
    it scrolls on, as it does under a page in hand: the OS drag moves no
    scroll of its own. Holding still keeps it going, so the loop does not wait
    for the next report. What marks the landing hears of every step. Only
    the shown tab's list need run it: each frame reads layout. */
export function useDropEdgeScroll(viewRef: RefObject<HTMLElement | null>, shown = true) {
  const drop = useSidebarDrop()

  useEffect(() => {
    if (drop !== "over" || !shown) {
      return
    }

    let frame = 0
    const edgeScroll = () => {
      const view = viewRef.current
      const step =
        view && dropPoint && view.getClientRects().length > 0
          ? columnEdgeStep(dropPoint, view.getBoundingClientRect())
          : 0

      if (view && step !== 0) {
        const before = view.scrollTop

        view.scrollBy({ top: step })

        // A new point of the same place: the content moved under it.
        if (view.scrollTop !== before && dropPoint) {
          dropPoint = { ...dropPoint }
          announceDropPoint()
        }
      }

      frame = requestAnimationFrame(edgeScroll)
    }

    frame = requestAnimationFrame(edgeScroll)

    return () => cancelAnimationFrame(frame)
  }, [drop, shown, viewRef])
}
