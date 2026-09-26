import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { invoke } from "@tauri-apps/api/core"

import { distanceFromView, pageWork } from "@/lib/pageWork"
import { resolveOutputScale } from "@/lib/pdf"

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
  const onPaintRef = useRef(onPaint)
  useLayoutEffect(() => {
    onPaintRef.current = onPaint
  }, [onPaint])

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
    const renderWidth = Math.round(
      Math.min(maxRenderWidth, targetWidth * outputScale * rotationScale),
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
        { priority: () => distanceFromView(canvas), signal: leaving.signal },
      )

      if (cancelled) {
        return
      }

      // Decoding the bytes straight into a bitmap keeps the image off the
      // document, so no `blob:` source is needed and the CSP stays untouched.
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: mimeType }),
      )

      if (cancelled) {
        bitmap.close()
        return
      }

      const context = canvas.getContext("2d", { alpha: false })

      if (!context) {
        bitmap.close()
        throw new Error("Canvas 2D rendering is unavailable")
      }

      canvas.width = bitmap.width
      canvas.height = bitmap.height
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
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
    renderEpoch,
    rotation,
    targetWidth,
  ])

  useEffect(() => {
    const canvas = canvasRef.current

    // A hidden tab reports every cell out of view; it is away, not far, and
    // clearing would re-render the whole grid on the way back.
    if (
      retainBitmap ||
      !canvas ||
      lastRenderRef.current === null ||
      canvas.getClientRects().length === 0
    ) {
      return
    }

    // Zero-sized drops the backing store; coming back renders it again.
    canvas.width = 0
    canvas.height = 0
    lastRenderRef.current = null
    setHasRendered(false)
  }, [canvasRef, retainBitmap])

  return { bitmapRevision, hasRendered, renderFailed }
}
