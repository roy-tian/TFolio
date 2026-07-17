import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import type { PdfPageInfo } from "@/lib/pdf"
import type { ViewMode } from "@/lib/viewMode"
import {
  applyWheelZoom,
  autoScale,
  bookColumnWidth,
  defaultZoomState,
  fitHeightScale,
  fitWidthScale,
  MAX_ZOOM,
  MIN_ZOOM,
  nextFitMode,
  normalizeWheelDelta,
  referenceDimensions,
  resolveZoomScale,
  stepZoomPercent,
  zoomToPercent,
  type ZoomState,
} from "@/lib/zoom"

// A point the reader is looking at, held still across a zoom. The page is
// remembered rather than a scroll offset because only the page scales: the gaps
// and padding around it are fixed, so an offset cannot be scaled to predict
// where the point lands. Re-measuring the page after the fact is exact.
type ZoomAnchor = {
  clientX: number
  clientY: number
  // Where in the page the point sits, as a fraction of its box. Outside 0..1 if
  // the point was beside the page, which still resolves to the right correction.
  fractionX: number
  fractionY: number
  pageNumber: number
}

type UseZoomOptions = {
  /** Height available to pages, once the column's padding is out. */
  contentHeight: number
  /** Width available to pages, once the column's padding is out. */
  contentWidth: number
  currentPage: number
  disabled: boolean
  pages: PdfPageInfo[]
  rotation: number
  viewMode: ViewMode
  viewerRef: RefObject<HTMLElement | null>
}

export function useZoom({
  contentHeight,
  contentWidth,
  currentPage,
  disabled,
  pages,
  rotation,
  viewMode,
  viewerRef,
}: UseZoomOptions) {
  const [zoom, setZoom] = useState<ZoomState>(defaultZoomState)
  // Bumped by every zoom the reader asks for, and what the anchor below is paid
  // back against. Watching the scale instead would strand an anchor whenever a
  // zoom resolved to the scale already showing — pressing `+` at the maximum,
  // say — leaving it to be paid back against some later, unrelated zoom.
  const [zoomRequest, setZoomRequest] = useState(0)
  const anchorRef = useRef<ZoomAnchor | null>(null)

  const { referenceHeight, referenceWidth, widestWidth } = useMemo(
    () => referenceDimensions(pages, rotation),
    [pages, rotation],
  )

  // A spread puts two pages in the column, so each fits half of it.
  const availableWidth =
    viewMode === "book" ? bookColumnWidth(contentWidth) : contentWidth

  // How wide the widest page will really be laid out. Only the single view lets
  // a page take its size from its own footprint, so only there can an odd wide
  // page out-grow the reference and need holding back: a spread hands both
  // halves the reference page's column whatever they measure, so nothing in it
  // can overflow, and holding it back would only shrink every spread for the
  // sake of a page that was never going to spill.
  const widestLaidOut = viewMode === "book" ? referenceWidth : widestWidth

  const fits = useMemo(
    () => ({
      auto: autoScale(availableWidth, referenceWidth, widestLaidOut),
      fitHeight: fitHeightScale(contentHeight, referenceHeight),
      fitWidth: fitWidthScale(availableWidth, referenceWidth),
    }),
    [
      availableWidth,
      contentHeight,
      referenceHeight,
      referenceWidth,
      widestLaidOut,
    ],
  )

  const scale = resolveZoomScale(zoom, fits)
  const percent = zoomToPercent(scale)

  // Lets the wheel read the live scale, and a zoom read the live page, without
  // either having to be rebound every time one of them changes — and lets a
  // gesture pick up from whatever a fit had resolved to. Written on commit
  // rather than in render, so a render React throws away cannot leave a scale
  // behind that was never shown.
  const scaleRef = useRef(scale)
  const currentPageRef = useRef(currentPage)

  useEffect(() => {
    scaleRef.current = scale
    currentPageRef.current = currentPage
  }, [currentPage, scale])

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

      const rect = page.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) {
        return
      }

      anchorRef.current = {
        clientX,
        clientY,
        fractionX: (clientX - rect.left) / rect.width,
        fractionY: (clientY - rect.top) / rect.height,
        pageNumber: Number(page.dataset.pageNumber),
      }
    },
    [viewerRef],
  )

  // Zooming from a button has no pointer to work from, so it holds the middle of
  // the viewer still. That keeps the reader where they were far better than
  // parking the page at the top would.
  const captureCentreAnchor = useCallback(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    const rect = viewer.getBoundingClientRect()
    captureAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [captureAnchor, viewerRef])

  /** Every zoom the reader asks for goes through here, so none skips its anchor. */
  const requestZoom = useCallback(
    (next: ZoomState | ((current: ZoomState) => ZoomState)) => {
      setZoom(next)
      setZoomRequest((request) => request + 1)
    },
    [],
  )

  // Pages only ever resize on a zoom, never unmount, so the anchor can be paid
  // back synchronously against the real post-zoom rect and never be seen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const viewer = viewerRef.current

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

    const rect = page.getBoundingClientRect()
    viewer.scrollLeft += rect.left + anchor.fractionX * rect.width - anchor.clientX
    viewer.scrollTop += rect.top + anchor.fractionY * rect.height - anchor.clientY
  }, [viewerRef, zoomRequest])

  const zoomTo = useCallback(
    (nextScale: number) => {
      captureCentreAnchor()
      requestZoom({ customScale: nextScale, mode: "custom" })
    },
    [captureCentreAnchor, requestZoom],
  )

  const zoomIn = useCallback(() => {
    zoomTo(stepZoomPercent(zoomToPercent(scaleRef.current), 1) / 100)
  }, [zoomTo])

  const zoomOut = useCallback(() => {
    zoomTo(stepZoomPercent(zoomToPercent(scaleRef.current), -1) / 100)
  }, [zoomTo])

  const resetZoom = useCallback(() => {
    zoomTo(1)
  }, [zoomTo])

  const toggleFit = useCallback(() => {
    captureCentreAnchor()
    // The custom scale rides along untouched, so leaving a fit later resumes the
    // zoom the reader last picked.
    requestZoom((current) => ({
      customScale: current.customScale,
      mode: nextFitMode(current.mode),
    }))
  }, [captureCentreAnchor, requestZoom])

  /** For a newly opened document, which has no reading position to keep. */
  const resetToDefault = useCallback(() => {
    anchorRef.current = null
    setZoom(defaultZoomState)
  }, [])

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
      // ctrlKey is also how a browser reports a trackpad pinch, so this picks up
      // that gesture for free. Anything else is an ordinary scroll: leave it be,
      // and leave it un-prevented.
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
        captureAnchor(pointerX, pointerY)
        requestZoom({
          customScale: applyWheelZoom(scaleRef.current, delta),
          mode: "custom",
        })
      })
    }

    viewer.addEventListener("wheel", handleWheel, { passive: false })

    return () => {
      viewer.removeEventListener("wheel", handleWheel)
      cancelAnimationFrame(frame)
    }
  }, [captureAnchor, disabled, requestZoom, viewerRef])

  return {
    canZoomIn: percent < MAX_ZOOM * 100,
    canZoomOut: percent > MIN_ZOOM * 100,
    referencePageWidth: referenceWidth,
    resetToDefault,
    resetZoom,
    scale,
    toggleFit,
    zoomIn,
    zoomMode: zoom.mode,
    zoomOut,
    zoomPercent: percent,
  }
}
