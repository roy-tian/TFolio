import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import type { CurrentPage } from "@/hooks/useCurrentPage"

// Matches the outline viewport's padding so a revealed row clears the edge.
const OUTLINE_REVEAL_MARGIN = 8

/** Scrolls an outline viewport no further than shows `row`, never moving
    clipped ancestors or scrolling sideways. */
export function scrollOutlineRowIntoView(
  nav: HTMLElement,
  row: HTMLElement,
  behavior: ScrollBehavior,
) {
  const navBox = nav.getBoundingClientRect()
  const rowBox = row.getBoundingClientRect()

  if (rowBox.top < navBox.top + OUTLINE_REVEAL_MARGIN) {
    nav.scrollBy({ behavior, top: rowBox.top - navBox.top - OUTLINE_REVEAL_MARGIN })
  } else if (rowBox.bottom > navBox.bottom - OUTLINE_REVEAL_MARGIN) {
    nav.scrollBy({ behavior, top: rowBox.bottom - navBox.bottom + OUTLINE_REVEAL_MARGIN })
  }
}

type FollowCurrentPageOptions<K> = {
  active: boolean
  currentPage: CurrentPage
  /** Active key reflected by the current render (page number or outline row key). */
  key: K
  /** Computes the key for a page number from the latest rendered props, so
      same-key `goTo` jumps scroll imperatively without forcing a re-render. */
  keyForPage: (pageNumber: number) => K
  /** Scrolls the active item into view; returns false while the viewport or
      target is hidden or not yet laid out. */
  scroll: (behavior: ScrollBehavior) => boolean
  /** Re-runs the layout check when caller readiness changes (e.g. grid columns, drag/edit). */
  readySignal?: unknown
}

/**
 * Follows the active item across a sidebar viewport: instantly on first
 * visible layout, smoothly when the active key changes, and imperatively
 * (without a React re-render) when an explicit `goTo` jump lands on the same
 * key after the reader scrolled the sidebar away.
 */
export function useFollowCurrentPage<K>({
  active,
  currentPage,
  key,
  keyForPage,
  readySignal,
  scroll,
}: FollowCurrentPageOptions<K>) {
  const followedRef = useRef<{ jump: number; key: K } | null>(null)
  const latestRef = useRef({ active, key, keyForPage, scroll })

  useLayoutEffect(() => {
    latestRef.current = { active, key, keyForPage, scroll }

    const last = followedRef.current
    const jump = currentPage.jumpCount()

    if (!active || (last !== null && Object.is(last.key, key) && last.jump === jump)) {
      return
    }

    const instant = last === null

    if (scroll(instant ? "instant" : "smooth")) {
      followedRef.current = { jump, key }
    }
  }, [active, currentPage, key, keyForPage, readySignal, scroll])

  useEffect(() => {
    return currentPage.subscribe(() => {
      const state = latestRef.current
      const last = followedRef.current
      const jump = currentPage.jumpCount()

      if (!state.active || last === null || last.jump === jump) {
        return
      }

      const nextKey = state.keyForPage(currentPage.get())

      // A key change triggers a React render whose `useLayoutEffect` scrolls
      // once the new active element is committed; only a same-key jump scrolls here.
      if (!Object.is(nextKey, state.key)) {
        return
      }

      if (state.scroll("smooth")) {
        followedRef.current = { jump, key: state.key }
      }
    })
  }, [currentPage])
}

/** Follows `[data-outline-current]` inside an outline `<nav>` viewport. */
export function useFollowOutlineRow({
  active,
  activeKey,
  currentPage,
  keyForPage,
  navRef,
  paused = false,
}: {
  active: boolean
  activeKey: string | null
  currentPage: CurrentPage
  keyForPage: (pageNumber: number) => string | null
  navRef: RefObject<HTMLElement | null>
  paused?: boolean
}) {
  const scroll = useCallback(
    (behavior: ScrollBehavior) => {
      const nav = navRef.current

      if (paused || !nav || nav.getClientRects().length === 0) {
        return false
      }

      const row = nav.querySelector<HTMLElement>("[data-outline-current]")

      if (row) {
        scrollOutlineRowIntoView(nav, row, behavior)
      }

      return true
    },
    [navRef, paused],
  )

  useFollowCurrentPage({
    active,
    currentPage,
    key: activeKey,
    keyForPage,
    readySignal: paused,
    scroll,
  })
}
