import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { useNearViewport } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import {
  dimensionsForRotation,
  MAX_RENDER_WIDTH,
  MIN_PAGE_RENDER_WIDTH,
  type PdfPageInfo,
  type PdfTextSpan,
} from "@/lib/pdf"
import { POINT_TO_PX } from "@/lib/zoom"

// A zoom gesture walks the page width through every value on its way to the one
// the reader wants, and each distinct one would otherwise cost a full PDFium
// re-raster of every visible page. Sitting out the burst costs nothing visually:
// the canvas is stretched to its box by CSS, so it tracks the new size straight
// away and only resolves to it once the reader pauses. Comfortably longer than
// a wheel notch, short enough to read as part of the gesture.
const RENDER_SETTLE_MS = 150

// The transparent text layer renders every span with the same font family that
// measures the run width, so the horizontal scale stays consistent between
// measurement and layout.
const TEXT_LAYER_FONT_FAMILY = "sans-serif"

let measureContext: CanvasRenderingContext2D | null = null

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
  documentId: number
  page: PdfPageInfo
  pageNumber: number
  rotation: number
  /** Resolved zoom; 1 lays the page out at one PDF point per CSS pixel. */
  scale: number
  /**
   * CSS pixels to lay the page out at, overriding `scale`. Only for a layout
   * that has to share one column across pages of different sizes, as a book
   * spread does; elsewhere every page takes its own size from the zoom.
   */
  width?: number
}

export function PdfPage({
  documentId,
  page,
  pageNumber,
  rotation,
  scale,
  width,
}: PdfPageProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isNearViewport = useNearViewport(wrapperRef)
  const [textSpans, setTextSpans] = useState<PdfTextSpan[]>([])

  // The user rotation spins the whole page (canvas + text layer) clockwise. It
  // is applied on top of the bitmap's displayed dimensions, so a 90°/270° user
  // rotation swaps the on-screen footprint the page occupies in the column.
  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, page.width, page.height)

  const displayWidth = width ?? footprintWidth * POINT_TO_PX * scale
  const settledWidth = useDebouncedValue(displayWidth, RENDER_SETTLE_MS)

  const { hasRendered, renderFailed } = usePageBitmap({
    canvasRef,
    command: "render_pdf_page",
    documentId,
    isNearViewport,
    maxRenderWidth: MAX_RENDER_WIDTH,
    mimeType: "image/png",
    page,
    pageNumber,
    rotation,
    targetWidth:
      settledWidth > 0
        ? Math.round(Math.max(MIN_PAGE_RENDER_WIDTH, settledWidth))
        : 0,
  })

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
      className="relative shrink-0 scroll-mt-5 overflow-hidden bg-white shadow-md ring-1 ring-black/10"
      data-page-number={pageNumber}
      ref={wrapperRef}
      style={{ aspectRatio: footprintWidth / footprintHeight, width: displayWidth }}
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
