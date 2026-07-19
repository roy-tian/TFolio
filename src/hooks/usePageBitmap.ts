import { useEffect, useRef, useState, type RefObject } from "react"
import { invoke } from "@tauri-apps/api/core"

import type { PdfPageInfo } from "@/lib/pdf"

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
  page: PdfPageInfo
  pageNumber: number
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
  page,
  pageNumber,
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
    const outputScale = Math.min(window.devicePixelRatio || 1, 2)
    // A 90°/270° rotation makes the page's width span more CSS pixels for a
    // landscape page (its long side becomes the height the column caps), and
    // rotation itself does not re-render. Render at that wider target so a
    // rotated landscape page stays sharp; portrait pages get smaller when
    // rotated, so the base target already covers them (scale stays 1).
    const rotationScale =
      rotation === 90 || rotation === 270
        ? Math.max(1, page.width / page.height)
        : 1
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
    page.height,
    page.width,
    pageNumber,
    renderEpoch,
    rotation,
    targetWidth,
  ])

  return { bitmapRevision, hasRendered, renderFailed }
}
