import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import type { PageRotations } from "@/lib/pageRotation"
import type { PdfPageInfo } from "@/lib/pdf"
import { spreadPages, type ViewMode } from "@/lib/viewMode"
import {
  anchorCorrection,
  anchorOnPage,
  type ViewportAnchor,
} from "@/lib/viewportAnchor"
import {
  applyWheelZoom,
  autoScale,
  bookColumnWidth,
  defaultZoomState,
  fitDimensions,
  fitPageScale,
  fitWidthScale,
  MAX_ZOOM,
  MIN_ZOOM,
  nextFitMode,
  normalizeWheelDelta,
  referenceDimensions,
  resolveZoomScale,
  stepZoomPercent,
  zoomToPercent,
  ZOOM_PREVIEW_EVENT,
  type ZoomState,
} from "@/lib/zoom"

type ZoomPreview = {
  baseScale: number
  clientX: number
  clientY: number
  layoutLeft: number
  layoutTop: number
  scale: number
  scrollLeft: number
  scrollTop: number
}

// One viewer-level timer replaces a former timer in every mounted page; the
// gesture commits one layout and render once it has been quiet this long.
const WHEEL_PREVIEW_SETTLE_MS = 150

type UseZoomOptions = {
  /** Height available to pages, once the column's padding is out. */
  contentHeight: number
  /** Width available to pages, once the column's padding is out. */
  contentWidth: number
  currentPage: number
  disabled: boolean
  /** A recent file's own zoom, over the fresh-document default. */
  initialZoom?: ZoomState
  pages: PdfPageInfo[]
  rotations: PageRotations
  viewMode: ViewMode
  viewerRef: RefObject<HTMLElement | null>
}

export function useZoom({
  contentHeight,
  contentWidth,
  currentPage,
  disabled,
  initialZoom,
  pages,
  rotations,
  viewMode,
  viewerRef,
}: UseZoomOptions) {
  const [zoom, setZoom] = useState<ZoomState>(
    () => initialZoom ?? defaultZoomState,
  )
  const [zoomPreviewing, setZoomPreviewing] = useState(false)
  // What the anchor is paid back against; watching the scale instead would
  // strand it when a zoom resolves to the scale already showing (`+` at max).
  const [zoomRequest, setZoomRequest] = useState(0)
  // The point the reader is looking at, held still across a zoom.
  const anchorRef = useRef<ViewportAnchor | null>(null)
  const previewRef = useRef<ZoomPreview | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const previewDeadlineRef = useRef(0)

  const { referenceHeight, referenceWidth, widestWidth } = useMemo(
    () => referenceDimensions(pages, rotations),
    [pages, rotations],
  )

  const availableWidth =
    viewMode === "book" ? bookColumnWidth(contentWidth) : contentWidth

  // Only the single view lets an odd wide page out-grow the reference: a spread
  // hands both halves the reference column, so nothing in it can overflow.
  const widestLaidOut = viewMode === "book" ? referenceWidth : widestWidth

  // What a fit measures: the page the reader asked from, laid out as this view
  // lays it; only `auto`, which precedes any reading position, uses the usual page.
  const fitBox = useMemo(
    () =>
      fitDimensions(
        pages,
        viewMode === "book"
          ? spreadPages(zoom.fitPage, pages.length)
          : [zoom.fitPage],
        rotations,
        { referenceHeight, referenceWidth },
        viewMode === "book",
      ),
    [pages, referenceHeight, referenceWidth, rotations, viewMode, zoom.fitPage],
  )

  const fits = useMemo(
    () => ({
      auto: autoScale(availableWidth, referenceWidth, widestLaidOut),
      fitPage: fitPageScale(
        availableWidth,
        contentHeight,
        fitBox.width,
        fitBox.height,
      ),
      fitWidth: fitWidthScale(availableWidth, fitBox.width),
    }),
    [availableWidth, contentHeight, fitBox, referenceWidth, widestLaidOut],
  )

  const scale = resolveZoomScale(zoom, fits)
  const percent = zoomToPercent(scale)

  // Written on commit rather than in render, so a render React throws away
  // cannot leave behind a scale that was never shown.
  const scaleRef = useRef(scale)
  const currentPageRef = useRef(currentPage)

  useEffect(() => {
    scaleRef.current = scale
    currentPageRef.current = currentPage
  }, [currentPage, scale])

  const clearPreviewTransform = useCallback(() => {
    const layout = viewerRef.current?.querySelector<HTMLElement>(
      "[data-pdf-viewer-layout]",
    )

    if (!layout) {
      return
    }

    layout.style.removeProperty("transform")
    layout.style.removeProperty("transform-origin")
    layout.style.removeProperty("will-change")
  }, [viewerRef])

  const cancelPreview = useCallback(() => {
    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = undefined
    previewDeadlineRef.current = 0
    previewRef.current = null
    anchorRef.current = null
    clearPreviewTransform()
    setZoomPreviewing(false)
  }, [clearPreviewTransform])

  const captureAnchor = useCallback(
    (clientX: number, clientY: number) => {
      const viewer = viewerRef.current

      if (!viewer) {
        return
      }

      const page =
        document
          .elementFromPoint(clientX, clientY)
          ?.closest<HTMLElement>("[data-page-number]") ??
        viewer.querySelector<HTMLElement>(
          `[data-page-number="${currentPageRef.current}"]`,
        )

      if (!page) {
        return
      }

      const anchor = anchorOnPage(
        Number(page.dataset.pageNumber),
        page.getBoundingClientRect(),
        clientX,
        clientY,
      )

      if (anchor) {
        anchorRef.current = anchor
      }
    },
    [viewerRef],
  )

  // A button zoom has no pointer to work from, so it holds the middle of the
  // viewer still.
  const captureCentreAnchor = useCallback(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    const rect = viewer.getBoundingClientRect()
    captureAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [captureAnchor, viewerRef])

  /**
   * Takes an update of the current state rather than a whole one, so a caller
   * changing the mode cannot drop the custom scale or the page a fit measures.
   */
  const requestZoom = useCallback(
    (next: (current: ZoomState) => ZoomState) => {
      setZoom(next)
      setZoomRequest((request) => request + 1)
    },
    [],
  )

  const commitPreview = useCallback(() => {
    const preview = previewRef.current

    if (!preview) {
      return
    }

    const anchor = anchorRef.current
    const viewer = viewerRef.current

    if (anchor && viewer) {
      // Scrolling moves every transformed point by the opposite viewport delta;
      // carrying it into the anchor now keeps this off scroll-event timing.
      anchor.clientX -= viewer.scrollLeft - preview.scrollLeft
      anchor.clientY -= viewer.scrollTop - preview.scrollTop
    }

    clearTimeout(previewTimerRef.current)
    previewTimerRef.current = undefined
    previewDeadlineRef.current = 0
    previewRef.current = null
    // Also what flashes the level the gesture landed on; the gesture never
    // leaves the compositor, so this is its one commit and costs no extra render.
    requestZoom((current) => ({
      ...current,
      customScale: preview.scale,
      mode: "custom",
    }))
    setZoomPreviewing(false)
  }, [requestZoom, viewerRef])

  const schedulePreviewCommit = useCallback(() => {
    previewDeadlineRef.current = performance.now() + WHEEL_PREVIEW_SETTLE_MS

    // One active timer: later frames only move its deadline, so a long gesture
    // stops creating and cancelling a timer per frame.
    if (previewTimerRef.current !== undefined) {
      return
    }

    const settle = () => {
      const remaining = previewDeadlineRef.current - performance.now()

      if (remaining > 0) {
        previewTimerRef.current = setTimeout(settle, remaining)
        return
      }

      previewTimerRef.current = undefined
      // A delayed wheel frame and this timer can wake in one frame batch;
      // deferring two frames lets the wheel RAF re-arm it and commit once.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (
            previewTimerRef.current !== undefined ||
            !previewRef.current
          ) {
            return
          }

          commitPreview()
        }),
      )
    }

    previewTimerRef.current = setTimeout(settle, WHEEL_PREVIEW_SETTLE_MS)
  }, [commitPreview])

  // Page shells only resize on a zoom, so the anchor can be paid back
  // synchronously against the real post-zoom rect and never be seen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const viewer = viewerRef.current

    // Removed in the same layout effect that reconciles the new page boxes,
    // before either state paints, so no unscaled or double-scaled frame shows.
    clearPreviewTransform()

    if (!anchor || !viewer) {
      return
    }

    anchorRef.current = null

    const page = viewer.querySelector<HTMLElement>(
      `[data-page-number="${anchor.pageNumber}"]`,
    )

    if (!page) {
      return
    }

    const correction = anchorCorrection(anchor, page.getBoundingClientRect())
    viewer.scrollLeft += correction.left
    viewer.scrollTop += correction.top
  }, [clearPreviewTransform, viewerRef, zoomRequest])

  const zoomTo = useCallback(
    (nextScale: number) => {
      cancelPreview()
      captureCentreAnchor()
      requestZoom((current) => ({
        ...current,
        customScale: nextScale,
        mode: "custom",
      }))
    },
    [cancelPreview, captureCentreAnchor, requestZoom],
  )

  const zoomIn = useCallback(() => {
    const liveScale = previewRef.current?.scale ?? scaleRef.current
    zoomTo(stepZoomPercent(zoomToPercent(liveScale), 1) / 100)
  }, [zoomTo])

  const zoomOut = useCallback(() => {
    const liveScale = previewRef.current?.scale ?? scaleRef.current
    zoomTo(stepZoomPercent(zoomToPercent(liveScale), -1) / 100)
  }, [zoomTo])

  const toggleFit = useCallback(() => {
    cancelPreview()
    captureCentreAnchor()
      // The custom scale rides along untouched, so leaving a fit resumes the
      // zoom last picked; the page is fresh — "fit" means the page in front.
    requestZoom((current) => ({
      ...current,
      fitPage: currentPageRef.current,
      mode: nextFitMode(current.mode),
    }))
  }, [cancelPreview, captureCentreAnchor, requestZoom])

  /** For a newly opened document, which has no reading position to keep. */
  const resetToDefault = useCallback(() => {
    cancelPreview()
    setZoom(defaultZoomState)
  }, [cancelPreview])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer || disabled) {
      return
    }

    let frame = 0
    let pendingDelta = 0
    let pointerX = 0
    let pointerY = 0

    const handleWheel = (event: WheelEvent) => {
      // ctrlKey is also how a browser reports a trackpad pinch; anything else is
      // an ordinary scroll, left alone and un-prevented.
      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      // Without this the WebView zooms the whole app on top of the page.
      event.preventDefault()

      pendingDelta += normalizeWheelDelta(event.deltaY, event.deltaMode)
      pointerX = event.clientX
      pointerY = event.clientY

      // A trackpad can out-run the display, and every tick costs a relayout, so
      // fold whatever arrived into one zoom per frame.
      if (frame) {
        return
      }

      frame = requestAnimationFrame(() => {
        frame = 0
        const delta = pendingDelta
        pendingDelta = 0
        const viewerLayout = viewer.querySelector<HTMLElement>(
          "[data-pdf-viewer-layout]",
        )

        if (!viewerLayout) {
          return
        }

        let preview = previewRef.current

        if (!preview) {
          // Captured once: every following frame is a compositor transform, and
          // page geometry is not read again until the final scale commits.
          captureAnchor(pointerX, pointerY)
          const layoutRect = viewerLayout.getBoundingClientRect()
          preview = {
            baseScale: scaleRef.current,
            clientX: pointerX,
            clientY: pointerY,
            layoutLeft: layoutRect.left,
            layoutTop: layoutRect.top,
            scale: scaleRef.current,
            scrollLeft: viewer.scrollLeft,
            scrollTop: viewer.scrollTop,
          }
          previewRef.current = preview
          viewerLayout.style.transformOrigin = "0 0"
          viewerLayout.style.willChange = "transform"
          setZoomPreviewing(true)
        }

        preview.scale = applyWheelZoom(preview.scale, delta)
        const ratio = preview.scale / preview.baseScale
        const anchorX = preview.clientX - preview.layoutLeft
        const anchorY = preview.clientY - preview.layoutTop
        const translateX = anchorX * (1 - ratio)
        const translateY = anchorY * (1 - ratio)
        viewerLayout.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${ratio})`
        viewer.dispatchEvent(new Event(ZOOM_PREVIEW_EVENT))

        schedulePreviewCommit()
      })
    }

    viewer.addEventListener("wheel", handleWheel, { passive: false })
    viewer.addEventListener("scroll", commitPreview, { passive: true })

    return () => {
      viewer.removeEventListener("wheel", handleWheel)
      viewer.removeEventListener("scroll", commitPreview)
      cancelAnimationFrame(frame)
      cancelPreview()
    }
  }, [
    cancelPreview,
    captureAnchor,
    commitPreview,
    disabled,
    schedulePreviewCommit,
    viewerRef,
  ])

  return {
    canZoomIn: percent < MAX_ZOOM * 100,
    canZoomOut: percent > MIN_ZOOM * 100,
    referencePageWidth: referenceWidth,
    resetToDefault,
    scale,
    toggleFit,
    zoomIn,
    zoomMode: zoom.mode,
    zoomState: zoom,
    zoomOut,
    zoomPercent: percent,
    zoomPreviewing,
    zoomRequest,
  }
}
