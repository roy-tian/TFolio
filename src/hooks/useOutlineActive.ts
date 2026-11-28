import { createContext, useContext, useMemo, useSyncExternalStore } from "react"

import type { CurrentPage } from "@/hooks/useCurrentPage"

/** Which row of an outline stands for the page being read, by its key. */
export type OutlineActive = {
  get: () => string | null
  subscribe: (listener: () => void) => () => void
}

/** Each row asks for itself whether it is the one, so passing a bookmark
    renders the two rows concerned: the outline rendered whole, its every row's
    tooltips with it, held up a 615-bookmark document's scroll 330 ms per
    bookmark passed in Chromium. */
export const OutlineActiveContext = createContext<OutlineActive | null>(null)

const NOT_LISTENING = () => () => undefined

/** The row `keyForPage` names for the page being read, worked out once per
    page however many rows ask. */
export function useOutlineActive(
  currentPage: CurrentPage,
  keyForPage: (pageNumber: number) => string | null,
): OutlineActive {
  return useMemo(() => {
    let page: number | null = null
    let key: string | null = null

    return {
      get: () => {
        const now = currentPage.get()

        if (now !== page) {
          page = now
          key = keyForPage(now)
        }

        return key
      },
      subscribe: currentPage.subscribe,
    }
  }, [currentPage, keyForPage])
}

/** The same rows under another naming, as the bookmarks among a tree of files. */
export function useDerivedOutlineActive(
  active: OutlineActive,
  derive: (key: string | null) => string | null,
): OutlineActive {
  return useMemo(
    () => ({ get: () => derive(active.get()), subscribe: active.subscribe }),
    [active, derive],
  )
}

export function useOutlineActiveKey(active: OutlineActive) {
  return useSyncExternalStore(active.subscribe, active.get)
}

/** Whether the row keyed `key` stands for the page being read. */
export function useIsOutlineRowActive(key: string) {
  const active = useContext(OutlineActiveContext)

  return useSyncExternalStore(
    active?.subscribe ?? NOT_LISTENING,
    () => active !== null && active.get() === key,
  )
}
