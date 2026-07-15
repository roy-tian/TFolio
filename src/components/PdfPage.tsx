import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { PdfPageInfo } from "@/lib/pdf"

type PdfPageProps = {
  availableWidth: number
  documentId: number
  page: PdfPageInfo
  pageNumber: number
}

export function PdfPage({
  availableWidth,
  documentId,
  page,
  pageNumber,
}: PdfPageProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastRenderRef = useRef<{
    documentId: number
    renderWidth: number
  } | null>(null)
  const [isNearViewport, setIsNearViewport] = useState(false)
  const [hasRendered, setHasRendered] = useState(false)
  const [renderFailed, setRenderFailed] = useState(false)

  useEffect(() => {
    const wrapper = wrapperRef.current

    if (!wrapper) {
      return
    }

    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setIsNearViewport(entries.some((entry) => entry.isIntersecting))
      },
      { rootMargin: "800px 0px" },
    )

    observer.observe(wrapper)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas || !isNearViewport || availableWidth <= 0) {
      return
    }

    let cancelled = false
    const maximumWidth = Math.round(
      Math.max(240, Math.min(896, availableWidth - 64)),
    )
    const outputScale = Math.min(window.devicePixelRatio || 1, 2)
    const renderWidth = Math.round(maximumWidth * outputScale)
    const lastRender = lastRenderRef.current

    if (
      lastRender?.documentId === documentId &&
      lastRender.renderWidth === renderWidth
    ) {
      return
    }

    const renderPage = async () => {
      const png = await invoke<ArrayBuffer>("render_pdf_page", {
        documentId,
        pageNumber,
        width: renderWidth,
      })

      if (cancelled) {
        return
      }

      const bitmap = await createImageBitmap(
        new Blob([png], { type: "image/png" }),
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
      lastRenderRef.current = { documentId, renderWidth }
      setHasRendered(true)
      setRenderFailed(false)
    }

    void renderPage().catch(() => {
      if (!cancelled) {
        setRenderFailed(true)
      }
    })

    return () => {
      cancelled = true
    }
  }, [availableWidth, documentId, isNearViewport, pageNumber])

  return (
    <div
      aria-label={t("viewer.pageLabel", { pageNumber })}
      className="relative w-full max-w-4xl shrink-0 scroll-mt-5 overflow-hidden bg-white shadow-md ring-1 ring-black/10"
      data-page-number={pageNumber}
      ref={wrapperRef}
    >
      <canvas
        className="block h-auto w-full"
        height={Math.max(1, Math.round(page.height))}
        ref={canvasRef}
        width={Math.max(1, Math.round(page.width))}
      />
      {!hasRendered && !renderFailed ? (
        <div className="absolute inset-0 grid place-items-center bg-white text-zinc-400">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      ) : null}
      {renderFailed ? (
        <div className="absolute inset-0 grid place-items-center bg-white p-6 text-center text-sm text-zinc-500">
          <span className="flex flex-col items-center gap-2">
            <TriangleAlert className="size-5" />
            {t("viewer.pageError", { pageNumber })}
          </span>
        </div>
      ) : null}
    </div>
  )
}
