import { useEffect, useRef, type RefObject } from "react"

import { pickCurrentPage, type PageCandidate } from "@/lib/pdf"
import type { ViewMode } from "@/lib/viewMode"

/**
 * Re-runs on `viewMode`, and on `pages`: switching modes re-parents every page
 * node, and a page list replaced by an insert or paste adds ones nobody
 * observes; either way the observer would silently stop reporting.
 */
export function useCurrentPageTracker(
  viewerRef: RefObject<HTMLElement | null>,
  documentId: number | undefined,
  viewMode: ViewMode,
  onPageChange: (pageNumber: number) => void,
  paused = false,
  pages?: unknown,
) {
  const onPageChangeRef = useRef(onPageChange)
  // A zoom preview moves the document on the compositor without changing its
  // layout boxes, so tracking it reports stale geometry: the answer waits for
  // the commit. Read, not depended on — re-observing every page per gesture
  // would cost more than the tracking it pauses.
  const pausedRef = useRef(paused)
  const updateRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    onPageChangeRef.current = onPageChange
  })

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
    const visiblePages = new Set<HTMLElement>()

    const updateCurrentPage = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        if (visiblePages.size === 0 || pausedRef.current) {
          return
        }

        const viewerBounds = viewer.getBoundingClientRect()
        const candidates: PageCandidate[] = []

        for (const page of visiblePages) {
          const pageBounds = page.getBoundingClientRect()

          candidates.push({
            bottom: pageBounds.bottom,
            pageNumber: Number(page.dataset.pageNumber),
            top: pageBounds.top,
          })
        }

        const currentPage = pickCurrentPage(
          candidates,
          viewerBounds.top,
          viewerBounds.bottom,
        )

        if (currentPage !== null) {
          onPageChangeRef.current(currentPage)
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
    updateRef.current = updateCurrentPage

    return () => {
      cancelAnimationFrame(animationFrame)
      visibilityObserver.disconnect()
      viewer.removeEventListener("scroll", updateCurrentPage)
      updateRef.current = () => undefined
    }
  }, [documentId, pages, viewMode, viewerRef])
}
