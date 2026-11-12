import { createContext, useContext, useSyncExternalStore } from "react"

/** What a file drag makes of the sidebar on screen: a target that takes the
    dragged files into one document ("over" while the pointer is on it), the
    shown tab's or a new one, or nothing at all. */
export type SidebarDrop = "offered" | "over" | null

export const SidebarDropContext = createContext<SidebarDrop>(null)

export function useSidebarDrop() {
  return useContext(SidebarDropContext)
}

// Apart from the context: a drag reports its point many times a second, and
// only the bar marking where the files would go needs it.
let dropPoint: { x: number; y: number } | null = null
const dropPointListeners = new Set<() => void>()

/** Where a file drag over the sidebar's pages stands, in CSS pixels; null
    off them, where the files would go to the end. */
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
