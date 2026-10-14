import { useSyncExternalStore } from "react"

/**
 * The page being read, kept outside React state: scrolling moves it every few
 * hundred pixels, and as session state each move re-rendered the session's
 * whole toolbar and viewer mid-scroll. Only what shows the number subscribes;
 * everything else reads it when it acts.
 */
export type CurrentPage = {
  get: () => number
  set: (pageNumber: number) => void
  subscribe: (listener: () => void) => () => void
}

export function createCurrentPage(initial: number): CurrentPage {
  let pageNumber = initial
  const listeners = new Set<() => void>()

  return {
    get: () => pageNumber,
    set: (next) => {
      if (next === pageNumber) {
        return
      }

      pageNumber = next

      for (const listener of listeners) {
        listener()
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useCurrentPage(currentPage: CurrentPage) {
  return useSyncExternalStore(currentPage.subscribe, currentPage.get)
}
