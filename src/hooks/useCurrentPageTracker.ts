import { useEffect, useRef, type RefObject } from "react"

import type { CurrentPage } from "@/hooks/useCurrentPage"
import { JUMP_ARRIVAL_MS, pickReadingPage, type PageCandidate } from "@/lib/pdf"
import type { ViewMode } from "@/lib/viewMode"
import { viewerReadingBounds } from "@/lib/viewerViewport"

/**
 * Re-runs on `viewMode`, and on `pages`: switching modes re-parents every page
 * node, and a page list replaced by an insert or paste adds ones nobody
 * observes; either way the observer would silently stop reporting.
 */
export function useCurrentPageTracker(
  viewerRef: RefObject<HTMLElement | null>,
  documentId: number | undefined,
  viewMode: ViewMode,
  currentPage: CurrentPage,
  paused = false,
  pages?: unknown,
) {
  // A zoom preview moves the document on the compositor without changing its
  // layout boxes, so tracking it reports stale geometry: the answer waits for
  // the commit. Read, not depended on — re-observing every page per gesture
  // would cost more than the tracking it pauses.
  const pausedRef = useRef(paused)
  const updateRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    pausedRef.current = paused

    if (!paused) {
      updateRef.current()
    }
  }, [paused])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer || documentId === undefined) {
      return
    }

    let animationFrame = 0
    let recheck = 0
    const visiblePages = new Set<HTMLElement>()

    const updateCurrentPage = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        if (visiblePages.size === 0 || pausedRef.current) {
          return
        }

        const viewerBounds = viewerReadingBounds(viewer)
        const candidates: PageCandidate[] = []

        for (const page of visiblePages) {
          const pageBounds = page.getBoundingClientRect()

          candidates.push({
            bottom: pageBounds.bottom,
            pageNumber: Number(page.dataset.pageNumber),
            top: pageBounds.top,
          })
        }

        const { jump, page } = pickReadingPage(
          candidates,
          { bottom: viewerBounds.bottom, scrollTop: viewer.scrollTop, top: viewerBounds.top },
          currentPage.jump,
          performance.now(),
        )

        currentPage.jump = jump

        if (page !== null) {
          currentPage.set(page)
        }

        // An arriving jump names its page whatever shows until its time is
        // up, and no scroll may come then to look again.
        window.clearTimeout(recheck)

        const arrivingFor = jump ? jump.since + JUMP_ARRIVAL_MS - performance.now() : 0

        if (arrivingFor > 0) {
          recheck = window.setTimeout(updateCurrentPage, arrivingFor)
        }
      })
    }

    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = entry.target as HTMLElement

          if (entry.isIntersecting) {
            visiblePages.add(page)
          } else {
            visiblePages.delete(page)
          }
        }

        updateCurrentPage()
      },
      { root: viewer },
    )

    for (const page of viewer.querySelectorAll<HTMLElement>(
      "[data-page-number]",
    )) {
      visibilityObserver.observe(page)
    }

    viewer.addEventListener("scroll", updateCurrentPage, { passive: true })
    const stopFollowingJumps = currentPage.subscribe(() => {
      if (currentPage.jump?.landedTop === null) {
        updateCurrentPage()
      }
    })
    updateRef.current = updateCurrentPage

    return () => {
      cancelAnimationFrame(animationFrame)
      window.clearTimeout(recheck)
      visibilityObserver.disconnect()
      viewer.removeEventListener("scroll", updateCurrentPage)
      stopFollowingJumps()
      updateRef.current = () => undefined
    }
  }, [currentPage, documentId, pages, viewMode, viewerRef])
}
