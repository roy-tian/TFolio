import { useEffect, useRef, useState, type RefObject } from "react"
import { invoke } from "@tauri-apps/api/core"

import { resolveOutputScale } from "@/lib/pdf"

type PageBitmapOptions = {
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Tauri command rendering the page, e.g. `render_pdf_page`. */
  command: string
  documentId: number
  isNearViewport: boolean
  /** Backend ceiling for the render width; the backend rejects wider. */
  maxRenderWidth: number
  /** MIME type of the bytes `command` returns. */
  mimeType: string
  /** Minimum backing pixels per CSS pixel; useful for low-DPI reading surfaces. */
  minOutputScale?: number
  /** The page's displayed size in points. Taken apart rather than as a
      `PdfPageInfo` so a caller whose page list is replaced wholesale — every
      structure edit replaces it — hands this hook numbers that compare equal
      instead of a fresh object. */
  pageHeight: number
  pageNumber: number
  pageWidth: number
  /**
   * Bumped when the page's content changes: the same page at the same width
   * renders differently once it has been drawn on, which nothing else about a
   * render request would reveal.
   */
  renderEpoch: number
  rotation: number
  /** CSS pixels the bitmap has to cover. Zero or less defers the render. */
  targetWidth: number
}

/**
 * Paints `pageNumber` onto `canvasRef` once it is near the viewport, and repaints
 * only when the resolved render width changes. Shared by the page and thumbnail
 * views, which differ just in their command, image format, and width ceiling.
 */
export function usePageBitmap({
  canvasRef,
  command,
  documentId,
  isNearViewport,
  maxRenderWidth,
  mimeType,
  minOutputScale = 1,
  pageHeight,
  pageNumber,
  pageWidth,
  renderEpoch,
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
    // A 90°/270° rotation makes the page's width span more CSS pixels for a
    // landscape page (its long side becomes the height the column caps), and
    // rotation itself does not re-render. Render at that wider target so a
    // rotated landscape page stays sharp; portrait pages get smaller when
    // rotated, so the base target already covers them (scale stays 1).
    const rotationScale =
      rotation === 90 || rotation === 270
        ? Math.max(1, pageWidth / pageHeight)
        : 1
    // The output-scale floor is a render *intent*, not a guarantee: once heavy
    // zoom pushes `targetWidth * outputScale * rotationScale` past
    // `maxRenderWidth`, the render is clamped and the effective backing ratio
    // drops back below the floor — at the extreme the text is a touch softer
    // than the floor promises.
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

    const renderPage = async () => {
      const bytes = await invoke<ArrayBuffer>(command, {
        documentId,
        pageNumber,
        width: renderWidth,
      })

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

  return { bitmapRevision, hasRendered, renderFailed }
}
