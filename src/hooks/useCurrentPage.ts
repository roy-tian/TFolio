import { useSyncExternalStore } from "react"

import type { JumpTarget } from "@/lib/pdf"

/**
 * The page being read, kept outside React state: scrolling moves it every few
 * hundred pixels, and as session state each move re-rendered the session's
 * whole toolbar and viewer mid-scroll. Only what shows the number subscribes;
 * everything else reads it when it acts.
 */
export type CurrentPage = {
  get: () => number
  /** The reader went to the page: it stays the page being read while it
      shows, though the view cannot bring it to the top (`pickReadingPage`). */
  goTo: (pageNumber: number) => void
  /** The jump `goTo` last made, which the tracker carries on and lets go. */
  jump: JumpTarget | null
  /** A move of the view the app made itself, as a turn that shortens the
      document clamping the scroll, or a zoom or resize re-anchoring it: the
      jump lands again where it leaves its page, rather than read as the
      reader reading on. */
  reland: () => void
  /** An edit moved the pages, and the page being read, or the one in its
      place, is now `pageNumber`. Where the view holds that page in place
      (`held`), a jump on it moves with it and lands again; else the scroll
      it started now ends on other pages, so it goes. */
  renumbered: (pageNumber: number, held: boolean) => void
  /** Where the tracker puts the page being read. */
  set: (pageNumber: number) => void
  subscribe: (listener: () => void) => () => void
}

export function createCurrentPage(initial: number): CurrentPage {
  let pageNumber = initial
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }
  const set = (next: number) => {
    if (next === pageNumber) {
      return
    }

    pageNumber = next
    notify()
  }

  const store: CurrentPage = {
    get: () => pageNumber,
    goTo: (next) => {
      store.jump = { landedTop: null, page: next, since: performance.now() }
      pageNumber = next
      // Told even when the page stays: the tracker lands a jump that scrolls
      // nothing at once, not on the reader's first scroll away.
      notify()
    },
    jump: null,
    reland: () => {
      if (store.jump) {
        store.jump = { ...store.jump, landedTop: null, since: performance.now() }
        notify()
      }
    },
    renumbered: (next, held) => {
      store.jump =
        store.jump && held ? { landedTop: null, page: next, since: performance.now() } : null

      pageNumber = next
      notify()
    },
    set,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }

  return store
}

export function useCurrentPage(currentPage: CurrentPage) {
  return useSyncExternalStore(currentPage.subscribe, currentPage.get)
}
