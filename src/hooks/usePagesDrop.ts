import { createContext, useContext, useSyncExternalStore } from "react"

/** What a file drag makes of the shown tab's pages: a target that adds the
    dragged files to the tab's document ("over" while the pointer is on it),
    or nothing at all. */
export type PagesDrop = "offered" | "over" | null

export const PagesDropContext = createContext<PagesDrop>(null)

export function usePagesDrop() {
  return useContext(PagesDropContext)
}

// Apart from the context: a drag reports its point many times a second, and
// only the bar marking where the files would go needs it.
let dropPoint: { x: number; y: number } | null = null
const dropPointListeners = new Set<() => void>()

/** Where a file drag over the pages stands, in CSS pixels; null off them. */
export function setPagesDropPoint(point: { x: number; y: number } | null) {
  if (point?.x === dropPoint?.x && point?.y === dropPoint?.y) {
    return
  }

  dropPoint = point
  dropPointListeners.forEach((listener) => listener())
}

function subscribeDropPoint(listener: () => void) {
  dropPointListeners.add(listener)

  return () => {
    dropPointListeners.delete(listener)
  }
}

export function usePagesDropPoint() {
  return useSyncExternalStore(subscribeDropPoint, () => dropPoint)
}
