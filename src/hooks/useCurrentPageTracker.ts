import { useEffect, useRef, type RefObject } from "react"

import { pickNearestPage, type PageCandidate } from "@/lib/pdf"
import type { ViewMode } from "@/lib/viewMode"

/**
 * Reports whichever page sits nearest the viewer's reading line as it scrolls.
 *
 * Every layout tags its pages with `data-page-number`, so this stays layout
 * agnostic. It does re-run on `viewMode` though: switching modes re-parents each
 * page node, and the observer would otherwise keep watching detached elements
 * and silently stop reporting.
 */
export function useCurrentPageTracker(
  viewerRef: RefObject<HTMLElement | null>,
  documentId: number | undefined,
  viewMode: ViewMode,
  onPageChange: (pageNumber: number) => void,
) {
  const onPageChangeRef = useRef(onPageChange)

  useEffect(() => {
    onPageChangeRef.current = onPageChange
  })

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
        if (visiblePages.size === 0) {
          return
        }

        // The reader's eye sits above the middle of the viewport, so the line
        // that decides the current page sits a third of the way down — capped,
        // so a tall window does not push it past the top of a short page.
        const viewerBounds = viewer.getBoundingClientRect()
        const readingLine =
          viewerBounds.top + Math.min(viewerBounds.height / 3, 240)
        const candidates: PageCandidate[] = []

        for (const page of visiblePages) {
          const pageBounds = page.getBoundingClientRect()

          candidates.push({
            bottom: pageBounds.bottom,
            pageNumber: Number(page.dataset.pageNumber),
            top: pageBounds.top,
          })
        }

        const nearestPage = pickNearestPage(candidates, readingLine)

        if (nearestPage !== null) {
          onPageChangeRef.current(nearestPage)
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

    return () => {
      cancelAnimationFrame(animationFrame)
      visibilityObserver.disconnect()
      viewer.removeEventListener("scroll", updateCurrentPage)
    }
  }, [documentId, viewMode, viewerRef])
}
