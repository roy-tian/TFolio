import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import type { CurrentPage } from "@/hooks/useCurrentPage"
import type { PdfPageInfo } from "@/lib/pdf"
import { spreadPages, type ViewMode } from "@/lib/viewMode"
import { viewerReadingBounds } from "@/lib/viewerViewport"
import {
  anchorCorrection,
  anchorOnPage,
  type ViewportAnchor,
} from "@/lib/viewportAnchor"
import {
  applyWheelZoom,
  autoScale,
  bookColumnWidth,
  clampZoom,
  defaultZoomState,
  fitDimensions,
  fitPageScale,
  fitWidthScale,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeWheelDelta,
  referenceDimensions,
  resolveZoomScale,
  stepZoomPercent,
  zoomToPercent,
  ZOOM_PREVIEW_EVENT,
  type ZoomPreset,
  type ZoomState,
} from "@/lib/zoom"

type ZoomPreview = {
  /** Whether its commit flashes the level: a wheel's does, a slider's has its
      own readout beside the thumb. */
  announce: boolean
  baseScale: number
  clientX: number
  clientY: number
  /** Held by a slider drag: only its release commits it, never a settle or a
      scroll, which could reach React after the next step began a preview. */
  held: boolean
  layoutLeft: number
  layoutTop: number
  scale: number
  scrollLeft: number
  scrollTop: number
}

type ZoomRequestOptions = {
  /** Flash the level over the pages, for a zoom asked for away from the
      status bar's readout. */
  announce?: boolean
}

// One viewer-level timer replaces a former timer in every mounted page; the
// gesture commits one layout and render once it has been quiet this long.
const WHEEL_PREVIEW_SETTLE_MS = 150

type UseZoomOptions = {
  /** Height available to pages, once the column's padding is out. */
  contentHeight: number
  /** Width available to pages, once the column's padding is out. */
  contentWidth: number
  currentPage: CurrentPage
  disabled: boolean
  /** A recent file's own zoom, over the fresh-document default. */
  initialZoom?: ZoomState
  pages: PdfPageInfo[]
  viewMode: ViewMode
  viewRotation: number
  viewerRef: RefObject<HTMLElement | null>
}

export function useZoom({
  contentHeight,
  contentWidth,
  currentPage,
  disabled,
  initialZoom,
  pages,
  viewMode,
  viewRotation,
  viewerRef,
}: UseZoomOptions) {
  const [zoom, setZoom] = useState<ZoomState>(
    () => initialZoom ?? defaultZoomState,
  )
  const [zoomPreviewing, setZoomPreviewing] = useState(false)
  // What the anchor is paid back against; watching the scale instead would
  // strand it when a zoom resolves to the scale already showing (`+` at max).
  const [zoomRequest, setZoomRequest] = useState(0)
  // Only zooms asked for away from the status bar's readout — the wheel, a
  // pinch, a key — flash the level over the pages.
  const [zoomAnnouncement, setZoomAnnouncement] = useState(0)
  // The point the reader is looking at, held still across a zoom.
  const anchorRef = useRef<ViewportAnchor | null>(null)
  const previewRef = useRef<ZoomPreview | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const previewDeadlineRef = useRef(0)

  const { referenceHeight, referenceWidth, widestWidth } = useMemo(
    () => referenceDimensions(pages, viewRotation),
    [pages, viewRotation],
  )

  // A spread is centred on its spine, so a page in it has half the column.
  const availableWidth =
    viewMode === "book" ? bookColumnWidth(contentWidth) : contentWidth

  // What a fit measures: the page the reader asked from, or its spread; only
  // `auto`, which precedes any reading position, uses the usual page.
  const fitBox = useMemo(
    () =>
      fitDimensions(
        pages,
        viewMode === "book"
          ? spreadPages(zoom.fitPage, pages.length)
          : [zoom.fitPage],
        viewRotation,
        { height: referenceHeight, width: referenceWidth },
      ),
    [pages, referenceHeight, referenceWidth, viewMode, viewRotation, zoom.fitPage],
  )

  const fits = useMemo(
    () => ({
      auto: autoScale(availableWidth, referenceWidth, widestWidth),
      fitPage: fitPageScale(
        availableWidth,
        contentHeight,
        fitBox.width,
        fitBox.height,
      ),
      fitWidth: fitWidthScale(availableWidth, fitBox.width),
    }),
    [availableWidth, contentHeight, fitBox, referenceWidth, widestWidth],
  )

  const scale = resolveZoomScale(zoom, fits)
  const percent = zoomToPercent(scale)

  // Written on commit rather than in render, so a render React throws away
  // cannot leave behind a scale that was never shown; in the layout phase, so a
  // preview begun before the passive effects run starts from the laid-out scale.
  const scaleRef = useRef(scale)

  useLayoutEffect(() => {
    scaleRef.current = scale
  }, [scale])

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
          `[data-page-number="${currentPage.get()}"]`,
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
    [currentPage, viewerRef],
  )

  // A button zoom has no pointer to work from, so it holds the middle of the
  // viewer still.
  const captureCentreAnchor = useCallback(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    const rect = viewerReadingBounds(viewer)
    captureAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [captureAnchor, viewerRef])

  /**
   * Takes an update of the current state rather than a whole one, so a caller
   * changing the mode cannot drop the custom scale or the page a fit measures.
   */
  const requestZoom = useCallback(
    (next: (current: ZoomState) => ZoomState, announce: boolean) => {
      setZoom(next)
      setZoomRequest((request) => request + 1)

      if (announce) {
        setZoomAnnouncement((announcement) => announcement + 1)
      }
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
    // Also what flashes the level a wheel landed on; the gesture never leaves
    // the compositor, so this is its one commit and costs no extra render.
    requestZoom(
      (current) => ({
        ...current,
        customScale: preview.scale,
        mode: "custom",
      }),
      preview.announce,
    )
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
            !previewRef.current ||
            previewRef.current.held
          ) {
            return
          }

          commitPreview()
        }),
      )
    }

    previewTimerRef.current = setTimeout(settle, WHEEL_PREVIEW_SETTLE_MS)
  }, [commitPreview])

  /**
   * A zoom shown as a compositor transform about a fixed point, not yet laid
   * out: every following frame of the gesture is only a transform, and page
   * geometry is not read again until it commits.
   */
  const previewZoomAt = useCallback(
    (
      // Called only to begin a preview, so later steps read no geometry.
      anchorPoint: () => { clientX: number; clientY: number },
      next: (scale: number) => number,
      { announce, settle }: { announce: boolean; settle: boolean },
    ) => {
      const viewer = viewerRef.current
      const viewerLayout = viewer?.querySelector<HTMLElement>(
        "[data-pdf-viewer-layout]",
      )

      if (!viewer || !viewerLayout) {
        return
      }

      let preview = previewRef.current

      if (!preview) {
        const { clientX, clientY } = anchorPoint()
        captureAnchor(clientX, clientY)
        const layoutRect = viewerLayout.getBoundingClientRect()
        preview = {
          announce,
          baseScale: scaleRef.current,
          clientX,
          clientY,
          held: false,
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

      // A slider taking over a wheel's preview drops its pending settle.
      if (!settle && !preview.held) {
        preview.held = true
        preview.announce = false
        clearTimeout(previewTimerRef.current)
        previewTimerRef.current = undefined
        previewDeadlineRef.current = 0
      }

      preview.scale = clampZoom(next(preview.scale))
      const ratio = preview.scale / preview.baseScale
      const anchorX = preview.clientX - preview.layoutLeft
      const anchorY = preview.clientY - preview.layoutTop
      const translateX = anchorX * (1 - ratio)
      const translateY = anchorY * (1 - ratio)
      viewerLayout.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${ratio})`
      viewer.dispatchEvent(new Event(ZOOM_PREVIEW_EVENT))

      if (settle && !preview.held) {
        schedulePreviewCommit()
      }
    },
    [captureAnchor, schedulePreviewCommit, viewerRef],
  )

  /**
   * A slider drag: previewed like a pinch, about the middle of the viewer, but
   * held until the slider lets go. A commit mid-drag could reach React after
   * the next step had begun a preview, which would scale from the old layout
   * and lose its anchor to that commit.
   */
  const previewScale = useCallback(
    (nextScale: number) => {
      const viewer = viewerRef.current

      if (!viewer || disabled) {
        return
      }

      previewZoomAt(
        () => {
          const rect = viewerReadingBounds(viewer)
          return {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }
        },
        () => nextScale,
        { announce: false, settle: false },
      )
    },
    [disabled, previewZoomAt, viewerRef],
  )

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
    (nextScale: number, announce: boolean) => {
      cancelPreview()
      captureCentreAnchor()
      requestZoom(
        (current) => ({
          ...current,
          customScale: nextScale,
          mode: "custom",
        }),
        announce,
      )
    },
    [cancelPreview, captureCentreAnchor, requestZoom],
  )

  // `announce` for a key: the status bar's own buttons sit beside its readout.
  const zoomIn = useCallback(
    (options: ZoomRequestOptions = {}) => {
      const liveScale = previewRef.current?.scale ?? scaleRef.current
      zoomTo(stepZoomPercent(zoomToPercent(liveScale), 1) / 100, Boolean(options.announce))
    },
    [zoomTo],
  )

  const zoomOut = useCallback(
    (options: ZoomRequestOptions = {}) => {
      const liveScale = previewRef.current?.scale ?? scaleRef.current
      zoomTo(stepZoomPercent(zoomToPercent(liveScale), -1) / 100, Boolean(options.announce))
    },
    [zoomTo],
  )

  const applyPreset = useCallback(
    (preset: ZoomPreset, options: ZoomRequestOptions = {}) => {
      const announce = Boolean(options.announce)

      if (preset === "actual-size") {
        zoomTo(1, announce)
        return
      }

      cancelPreview()
      captureCentreAnchor()
      // The page is fresh even when the fit is already on — "fit" means the
      // page in front, so pressing it again re-measures against that one.
      requestZoom(
        (current) => ({
          ...current,
          fitPage: currentPage.get(),
          mode: preset,
        }),
        announce,
      )
    },
    [cancelPreview, captureCentreAnchor, currentPage, requestZoom, zoomTo],
  )

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
        const anchorPoint = { clientX: pointerX, clientY: pointerY }
        previewZoomAt(() => anchorPoint, (scale) => applyWheelZoom(scale, delta), {
          announce: true,
          settle: true,
        })
      })
    }

    // A held preview carries the scroll into its anchor when it commits.
    const commitOnScroll = () => {
      if (!previewRef.current?.held) {
        commitPreview()
      }
    }

    viewer.addEventListener("wheel", handleWheel, { passive: false })
    viewer.addEventListener("scroll", commitOnScroll, { passive: true })

    return () => {
      viewer.removeEventListener("wheel", handleWheel)
      viewer.removeEventListener("scroll", commitOnScroll)
      cancelAnimationFrame(frame)
      cancelPreview()
    }
  }, [cancelPreview, commitPreview, disabled, previewZoomAt, viewerRef])

  return {
    applyPreset,
    canZoomIn: percent < MAX_ZOOM * 100,
    canZoomOut: percent > MIN_ZOOM * 100,
    commitPreview,
    previewScale,
    resetToDefault,
    scale,
    zoomIn,
    zoomMode: zoom.mode,
    zoomState: zoom,
    zoomOut,
    zoomPercent: percent,
    zoomAnnouncement,
    zoomPreviewing,
    zoomRequest,
  }
}
