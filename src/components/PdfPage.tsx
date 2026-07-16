import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { PdfPageInfo, PdfTextSpan } from "@/lib/pdf"

// The transparent text layer renders every span with the same font family that
// measures the run width, so the horizontal scale stays consistent between
// measurement and layout.
const TEXT_LAYER_FONT_FAMILY = "sans-serif"

let measureContext: CanvasRenderingContext2D | null = null

// Mirrors MAX_RENDER_WIDTH in src-tauri/src/pdfium.rs; the backend rejects wider.
const MAX_RENDER_WIDTH = 4096

// Rotating a page by 90° or 270° swaps its width and height; 0°/180° leave them.
function dimensionsForRotation(rotation: number, width: number, height: number) {
  return rotation === 90 || rotation === 270
    ? { height: width, width: height }
    : { height, width }
}

// Natural width, in the same units as `fontSize`, that `text` occupies in the
// text-layer font. Used to derive the horizontal scale that stretches a span to
// match the width PDFium reported for the run.
function measureTextWidth(text: string, fontSize: number) {
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d")
  }

  if (!measureContext) {
    return 0
  }

  measureContext.font = `${fontSize}px ${TEXT_LAYER_FONT_FAMILY}`

  return measureContext.measureText(text).width
}

type PdfPageProps = {
  availableWidth: number
  documentId: number
  page: PdfPageInfo
  pageNumber: number
  rotation: number
}

export function PdfPage({
  availableWidth,
  documentId,
  page,
  pageNumber,
  rotation,
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
  const [textSpans, setTextSpans] = useState<PdfTextSpan[]>([])

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
      Math.min(MAX_RENDER_WIDTH, maximumWidth * outputScale * rotationScale),
    )
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
  }, [
    availableWidth,
    documentId,
    isNearViewport,
    page.height,
    page.width,
    pageNumber,
    rotation,
  ])

  useEffect(() => {
    if (!isNearViewport) {
      return
    }

    let cancelled = false
    setTextSpans([])

    void invoke<PdfTextSpan[]>("extract_pdf_page_text", {
      documentId,
      pageNumber,
    })
      .then((spans) => {
        if (!cancelled) {
          setTextSpans(spans)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTextSpans([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [documentId, isNearViewport, pageNumber])

  // Text spans are in the page's unrotated coordinate space. For 90°/270° pages
  // the unrotated dimensions are the displayed ones swapped; the layer itself is
  // rotated (below) to line back up with the rendered bitmap.
  const { height: layoutHeight, width: layoutWidth } = dimensionsForRotation(
    page.rotation,
    page.width,
    page.height,
  )

  // The user rotation spins the whole page (canvas + text layer) clockwise. It
  // is applied on top of the bitmap's displayed dimensions, so a 90°/270° user
  // rotation swaps the on-screen footprint the page occupies in the column.
  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, page.width, page.height)

  // Positions are page-relative and the horizontal scale is resolution
  // independent, so this only needs recomputing when the spans themselves
  // change — not on every resize-driven re-render.
  const positionedSpans = useMemo(
    () =>
      textSpans.map((span) => {
        const naturalWidth = measureTextWidth(span.text, span.height)
        const scaleX = naturalWidth > 0 ? span.width / naturalWidth : 1

        return {
          fontSize: `${(span.height / layoutHeight) * 100}cqh`,
          left: `${(span.left / layoutWidth) * 100}%`,
          text: span.text,
          top: `${(span.top / layoutHeight) * 100}%`,
          transform: scaleX === 1 ? undefined : `scaleX(${scaleX})`,
        }
      }),
    [layoutHeight, layoutWidth, textSpans],
  )

  return (
    <div
      aria-label={t("viewer.pageLabel", { pageNumber })}
      className="relative w-full max-w-4xl shrink-0 scroll-mt-5 overflow-hidden bg-white shadow-md ring-1 ring-black/10"
      data-page-number={pageNumber}
      ref={wrapperRef}
      style={{ aspectRatio: footprintWidth / footprintHeight }}
    >
      <div
        className="absolute"
        style={{
          height: `${(page.height / footprintHeight) * 100}%`,
          left: "50%",
          top: "50%",
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          width: `${(page.width / footprintWidth) * 100}%`,
        }}
      >
        <canvas
          className="block h-full w-full"
          height={Math.max(1, Math.round(page.height))}
          ref={canvasRef}
          width={Math.max(1, Math.round(page.width))}
        />
        {hasRendered && positionedSpans.length > 0 ? (
          <div
            className="pdf-text-layer"
            style={{
              height: `${(layoutHeight / page.height) * 100}%`,
              left: "50%",
              top: "50%",
              transform: `translate(-50%, -50%) rotate(${page.rotation}deg)`,
              width: `${(layoutWidth / page.width) * 100}%`,
            }}
          >
            {positionedSpans.map((span, index) => (
              <span
                key={index}
                style={{
                  fontSize: span.fontSize,
                  left: span.left,
                  top: span.top,
                  transform: span.transform,
                }}
              >
                {span.text}
              </span>
            ))}
          </div>
        ) : null}
      </div>
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
