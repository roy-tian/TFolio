import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { RefObject } from "react"

import {
  anchorCorrection,
  anchorOnPage,
  type ViewportAnchor,
} from "@/lib/viewportAnchor"
import type { ViewMode } from "@/lib/viewMode"

const RESIZE_COMPOSITOR_SETTLE_MS = 150

type UseViewerViewportOptions = {
  active: boolean
  currentPage: number
  currentPageRef: RefObject<number>
  restoringRecentView: boolean
  scrollToPage: (pageNumber: number, behavior?: ScrollBehavior) => void
  viewMode: ViewMode
  viewerRef: RefObject<HTMLElement | null>
}

/**
 * The viewer's box and the reading position that survives its changes: the
 * resize compositor, the anchor that pays the reader's place back after a
 * resize, and the queued seeks a view swap or returning tab owes.
 */
export function useViewerViewport({
  active,
  currentPage,
  currentPageRef,
  restoringRecentView,
  scrollToPage,
  viewMode,
  viewerRef,
}: UseViewerViewportOptions) {
  const [viewerWidth, setViewerWidth] = useState(0)
  const [viewerHeight, setViewerHeight] = useState(0)
  // The mode the last commit actually laid out, so a switch can be told from a
  // re-render — the layout is what strands an offset, not the stored choice.
  const laidOutViewModeRef = useRef(viewMode)
  // Where the reader was when the viewport last changed size, taken before the
  // layout that change resolves to, and paid back once it has been made.
  const resizeAnchorRef = useRef<ViewportAnchor | null>(null)
  // The last geometry the viewer really had, which a hidden tab keeps.
  const committedSizeRef = useRef({ height: 0, width: 0 })
  // A seek waiting for the layout that can land it; between request and commit
  // the reader's place is that page, not wherever the scroll currently sits.
  const pendingScrollPageRef = useRef<number | null>(null)

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    // Taken while the old layout stands: fitting pages to a new width slides
    // the page away. The reading line is the viewer's own top edge.
    const captureResizeAnchor = () => {
      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${currentPageRef.current}"]`,
      )
      const rect = viewer.getBoundingClientRect()
      const pageRect = page?.getBoundingClientRect()

      // Only a page on screen can hold the reader's place: mid-seek the tracked
      // page is pages off, and anchoring to it lands nowhere the reader was.
      resizeAnchorRef.current =
        pageRect && pageRect.bottom > rect.top && pageRect.top < rect.bottom
          ? anchorOnPage(
              currentPageRef.current,
              pageRect,
              rect.left + rect.width / 2,
              rect.top,
            )
          : null
    }

    // A hidden tab has no layout box and the observer reports 0x0; committing
    // that loses the reader's place. Hold the last real geometry instead.
    const commitSize = (width: number, height: number) => {
      const roundedWidth = Math.round(width)
      const roundedHeight = Math.round(height)

      if (roundedWidth <= 0 || roundedHeight <= 0) {
        return
      }

      const committed = committedSizeRef.current

      if (
        roundedWidth === committed.width &&
        roundedHeight === committed.height
      ) {
        return
      }

      // Skip the first size, which has no reading position behind it, and any
      // pending seek — a returning tab finds its page its own way.
      if (committed.width > 0 && pendingScrollPageRef.current === null) {
        captureResizeAnchor()
      }

      if (roundedWidth !== committed.width) {
        committed.width = roundedWidth
        setViewerWidth(roundedWidth)
      }

      if (roundedHeight !== committed.height) {
        committed.height = roundedHeight
        setViewerHeight(roundedHeight)
      }
    }

    commitSize(viewer.clientWidth, viewer.clientHeight)
    let compositorTimer: ReturnType<typeof setTimeout> | undefined

    // Layout tracks the window in real time; only the PDFium renders are
    // debounced. Measured off the element, the box the activation check reads.
    const resizeObserver = new ResizeObserver(() => {
      if (!viewer.dataset.resizeCompositing) {
        viewer.dataset.resizeCompositing = "true"
      }
      clearTimeout(compositorTimer)
      compositorTimer = setTimeout(() => {
        delete viewer.dataset.resizeCompositing
      }, RESIZE_COMPOSITOR_SETTLE_MS)
      commitSize(viewer.clientWidth, viewer.clientHeight)
    })
    resizeObserver.observe(viewer)

    return () => {
      resizeObserver.disconnect()
      clearTimeout(compositorTimer)
      delete viewer.dataset.resizeCompositing
    }
  }, [])

  // A layout effect, so the correction lands in the same frame as the new size
  // and the reader sees the column change width, not the document jump.
  useLayoutEffect(() => {
    const anchor = resizeAnchorRef.current
    const viewer = viewerRef.current

    // A queued seek owns the offset instead: it names a page in the layout just
    // made, while the anchor describes one that was never committed.
    if (!anchor || !viewer || pendingScrollPageRef.current !== null) {
      resizeAnchorRef.current = null
      return
    }

    resizeAnchorRef.current = null

    const page = viewer.querySelector<HTMLElement>(
      `[data-page-number="${anchor.pageNumber}"]`,
    )

    if (!page) {
      return
    }

    const correction = anchorCorrection(anchor, page.getBoundingClientRect())
    viewer.scrollLeft += correction.left
    viewer.scrollTop += correction.top
  }, [viewerHeight, viewerWidth])

  // A tab hidden through a resize holds an offset into a stale layout; seek the
  // page once the new size is committed, as a layout effect or never at all.
  useLayoutEffect(() => {
    const viewer = viewerRef.current

    if (!active || !viewer || restoringRecentView) {
      return
    }

    const committed = committedSizeRef.current

    if (
      viewer.clientWidth === committed.width &&
      viewer.clientHeight === committed.height
    ) {
      return
    }

    pendingScrollPageRef.current = currentPage
  }, [active, currentPage, restoringRecentView])

  // For the switch nobody pressed: a merge past a one-page document's spread
  // brings book view back. A seek already queued is the more specific target.
  // Runs ahead of the commit below, which settles the seek this may queue.
  useEffect(() => {
    if (laidOutViewModeRef.current === viewMode) {
      return
    }

    laidOutViewModeRef.current = viewMode

    if (pendingScrollPageRef.current === null) {
      pendingScrollPageRef.current = currentPage
    }
  }, [currentPage, viewMode])

  // The target exists only once the new layout has mounted, so the scroll waits
  // for the commit — or, for a tab returning to a resized window, the geometry.
  useEffect(() => {
    const pendingPage = pendingScrollPageRef.current
    const viewer = viewerRef.current

    if (pendingPage === null || !viewer) {
      return
    }

    // The jump reads as a view swap rather than a scroll, so it lands instantly.
    scrollToPage(pendingPage, "auto")

    const committed = committedSizeRef.current

    // Leaving the grid closes the bookmark sidebar, widening the viewer after
    // the seek was measured; hold the page until settled, so the last seek stands.
    if (
      viewer.clientWidth === committed.width &&
      viewer.clientHeight === committed.height
    ) {
      pendingScrollPageRef.current = null
    }
  }, [viewerHeight, viewerWidth, viewMode])

  return {
    committedSizeRef,
    pendingScrollPageRef,
    viewerHeight,
    viewerWidth,
  }
}
