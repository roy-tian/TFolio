import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { invoke } from "@tauri-apps/api/core"

import { decodeImage } from "@/lib/imageDecode"
import { distanceFromView, pageWork } from "@/lib/pageWork"
import { releaseCanvas, type ParkedPreviews } from "@/lib/parkedPreviews"
import { MIN_RENDER_WIDTH, resolveOutputScale } from "@/lib/pdf"

type PageBitmapOptions = {
  canvasRef: RefObject<HTMLCanvasElement | null>
  command: string
  documentId: number
  isNearViewport: boolean
  /** Backend ceiling for the render width; the backend rejects wider. */
  maxRenderWidth: number
  mimeType: string
  minOutputScale?: number
  /** Runs in the same task as the canvas replacement, before browser paint. */
  onPaint?: (pageNumber: number, renderEpoch: number) => void
  /** Numbers, not a `PdfPageInfo`: structure edits replace the page list, and
      primitives compare equal where a fresh object would not. */
  pageHeight: number
  pageNumber: number
  pageWidth: number
  /** Where the canvas parks as it unmounts, under `parkKey`, and what it takes
      up again when the same page comes back. */
  parked?: ParkedPreviews
  parkKey?: number
  /** Pixels added to the distance the work queue ranks this render by. */
  priorityBias?: number
  /**
   * Bumped when the page's content changes: drawing on it changes the render
   * at the same width, which nothing else about the request would reveal.
   */
  renderEpoch: number
  /** False once the page is far enough off screen to give its pixels back:
      a canvas keeps its whole backing store while it stays mounted. */
  retainBitmap?: boolean
  rotation: number
  targetWidth: number
}

// Pixels a page brought back took up rather than rendered: held as a render, so
// they are given back like one, but matching no request, so it still renders.
const ADOPTED = { documentId: Number.NaN, renderEpoch: Number.NaN, renderWidth: Number.NaN }

export function usePageBitmap({
  canvasRef,
  command,
  documentId,
  isNearViewport,
  maxRenderWidth,
  mimeType,
  minOutputScale = 1,
  onPaint,
  pageHeight,
  pageNumber,
  pageWidth,
  parked,
  parkKey,
  priorityBias = 0,
  renderEpoch,
  retainBitmap = true,
  rotation,
  targetWidth,
}: PageBitmapOptions) {
  const lastRenderRef = useRef<{
    documentId: number
    renderEpoch: number
    renderWidth: number
  } | null>(null)
  const [hasRendered, setHasRendered] = useState(false)
  const [renderFailed, setRenderFailed] = useState(false)
  const [bitmapRevision, setBitmapRevision] = useState(0)
  // `retainBitmap` starts false, before its observer has said anything:
  // nothing counts as far until it has once been near.
  const retainedRef = useRef(false)
  const onPaintRef = useRef(onPaint)
  useLayoutEffect(() => {
    onPaintRef.current = onPaint
  }, [onPaint])

  // Before the first paint, so a page brought back never shows blank. Only in
  // view: there its own render follows at once, and out of it nobody sees them.
  useLayoutEffect(() => {
    const canvas = canvasRef.current

    if (!parked || parkKey === undefined || !canvas) {
      return
    }

    const bitmap = parked.take(parkKey)
    const context =
      bitmap && distanceFromView(canvas) === 0 && canvas.getContext("bitmaprenderer")

    if (bitmap && context) {
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      context.transferFromImageBitmap(bitmap)
      lastRenderRef.current = ADOPTED
      setHasRendered(true)
      setBitmapRevision((revision) => revision + 1)
    } else {
      bitmap?.close()
    }

    return () => parked.park(parkKey, canvas)
  }, [canvasRef, parked, parkKey])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas || !isNearViewport || targetWidth <= 0) {
      return
    }

    let cancelled = false
    const outputScale = resolveOutputScale(
      window.devicePixelRatio,
      minOutputScale,
    )
    // A rotated landscape page spans more CSS pixels and rotation alone does
    // not re-render; portrait shrinks, so the base target already covers it.
    const rotationScale =
      rotation === 90 || rotation === 270
        ? Math.max(1, pageWidth / pageHeight)
        : 1
    // The output-scale floor is an intent, not a guarantee: past
    // `maxRenderWidth` the render is clamped and the backing ratio drops below it.
    // The backend also rejects narrower than MIN_RENDER_WIDTH, which a tall,
    // narrow page's thumbnail falls under.
    const renderWidth = Math.round(
      Math.min(
        maxRenderWidth,
        Math.max(MIN_RENDER_WIDTH, targetWidth * outputScale * rotationScale),
      ),
    )
    const lastRender = lastRenderRef.current

    if (
      lastRender?.documentId === documentId &&
      lastRender.renderWidth === renderWidth &&
      lastRender.renderEpoch === renderEpoch
    ) {
      return
    }

    const leaving = new AbortController()

    const renderPage = async () => {
      const bytes = await pageWork.schedule(
        () =>
          invoke<ArrayBuffer>(command, {
            documentId,
            pageNumber,
            width: renderWidth,
          }),
        {
          priority: () => distanceFromView(canvas) + priorityBias,
          signal: leaving.signal,
        },
      )

      if (cancelled) {
        return
      }

      // Decoding the bytes straight into a bitmap keeps the image off the
      // document, so no `blob:` source is needed and the CSP stays untouched.
      const bitmap = await decodeImage(bytes, mimeType)

      if (cancelled) {
        bitmap.close()
        return
      }

      // Takes the bitmap without the copy a 2d `drawImage` makes on this
      // thread. The canvas then has no 2d context to read pixels back from.
      const context = canvas.getContext("bitmaprenderer")

      if (!context) {
        bitmap.close()
        throw new Error("Canvas bitmap rendering is unavailable")
      }

      // Readers take `canvas.width` as the bitmap's width; a transfer alone
      // need not resize the canvas.
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      context.transferFromImageBitmap(bitmap)
      lastRenderRef.current = { documentId, renderEpoch, renderWidth }
      onPaintRef.current?.(pageNumber, renderEpoch)
      setHasRendered(true)
      setRenderFailed(false)
      setBitmapRevision((revision) => revision + 1)
    }

    void renderPage().catch(() => {
      if (!cancelled) {
        setRenderFailed(true)
      }
    })

    return () => {
      cancelled = true
      leaving.abort()
    }
  }, [
    canvasRef,
    command,
    documentId,
    isNearViewport,
    maxRenderWidth,
    mimeType,
    minOutputScale,
    pageHeight,
    pageNumber,
    pageWidth,
    priorityBias,
    renderEpoch,
    rotation,
    targetWidth,
  ])

  useEffect(() => {
    const canvas = canvasRef.current

    if (retainBitmap) {
      retainedRef.current = true
      return
    }

    // A hidden tab reports every cell out of view; it is away, not far, and
    // clearing would re-render every preview on the way back.
    if (
      !retainedRef.current ||
      !canvas ||
      lastRenderRef.current === null ||
      canvas.getClientRects().length === 0
    ) {
      return
    }

    // Coming back renders it again.
    releaseCanvas(canvas)
    lastRenderRef.current = null
    setHasRendered(false)
  }, [canvasRef, retainBitmap])

  return { bitmapRevision, hasRendered, renderFailed }
}
