import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PageTextMenu } from "@/components/PageTextMenu"
import { RectDraftOverlay } from "@/components/RectDraftOverlay"
import { useNearViewport } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import type { RectDraft } from "@/hooks/useRectTool"
import {
  dimensionsForRotation,
  MAX_RENDER_WIDTH,
  MIN_PAGE_OUTPUT_SCALE,
  MIN_PAGE_RENDER_WIDTH,
  type PdfPageInfo,
  type PdfSearchMatch,
  type PdfTextSpan,
} from "@/lib/pdf"
import { POINT_TO_PX } from "@/lib/zoom"

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

type IndexedSearchMatch = {
  index: number
  match: PdfSearchMatch
}

type PdfPageProps = {
  activeSearchIndex: number | null
  documentId: number
  /** The rectangle being dragged out on this page, if any. */
  draft?: RectDraft
  page: PdfPageInfo
  pageNumber: number
  /** Bumped when the page is drawn on, so the bitmap is fetched again. */
  renderEpoch: number
  /** Viewer-level settled zoom used only to choose the bitmap resolution. */
  renderScale: number
  searchMatches: IndexedSearchMatch[]
  /** Bumped only when page content text changes. */
  textEpoch: number
  rotation: number
  /** Resolved zoom; 1 lays the page out at one PDF point per CSS pixel. */
  scale: number
  /** Keep the current heavy-page window fixed during a compositor zoom preview. */
  virtualizationPaused: boolean
  /** Do not evict mounted surfaces while a text-selection drag crosses pages. */
  virtualizationRetainExited: boolean
  /**
   * CSS pixels to lay the page out at, overriding `scale`. Only for a layout
   * that has to share one column across pages of different sizes, as a book
   * spread does; elsewhere every page takes its own size from the zoom.
   */
  width?: number
  /** Settled render width for a shared-column layout such as book mode. */
  renderWidth?: number
}

type PdfPageSurfaceProps = {
  activeSearchIndex: number | null
  documentId: number
  draft?: RectDraft
  footprintHeight: number
  footprintWidth: number
  page: PdfPageInfo
  pageNumber: number
  renderEpoch: number
  renderWidth: number
  rotation: number
  searchMatches: IndexedSearchMatch[]
  textEpoch: number
}

/**
 * The expensive half of a page. It exists only around the viewport, so leaving
 * a page releases its canvas backing store, extracted text, and annotation
 * preview instead of letting a long reading session retain all of them.
 */
function PdfPageSurface({
  activeSearchIndex,
  documentId,
  draft,
  footprintHeight,
  footprintWidth,
  page,
  pageNumber,
  renderEpoch,
  renderWidth,
  rotation,
  searchMatches,
  textEpoch,
}: PdfPageSurfaceProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [textSpans, setTextSpans] = useState<PdfTextSpan[]>([])

  const { bitmapRevision, hasRendered, renderFailed } = usePageBitmap({
    canvasRef,
    command: "render_pdf_page",
    documentId,
    // The whole surface is virtualised; if it is mounted, it is near enough to
    // render. This keeps the bitmap hook free of a second observer/state gate.
    isNearViewport: true,
    maxRenderWidth: MAX_RENDER_WIDTH,
    mimeType: "image/png",
    minOutputScale: MIN_PAGE_OUTPUT_SCALE,
    pageHeight: page.height,
    pageNumber,
    pageWidth: page.width,
    renderEpoch,
    rotation,
    targetWidth:
      renderWidth > 0
        ? Math.round(Math.max(MIN_PAGE_RENDER_WIDTH, renderWidth))
        : 0,
  })

  useEffect(() => {
    let cancelled = false
    // A text epoch means the page's selectable content is no longer the content
    // these spans describe. Do not leave stale runs clickable while PDFium
    // extracts the replacement — especially after pages of different sizes move.
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
  }, [documentId, pageNumber, textEpoch])

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
  const pageLayerStyle = {
    height: `${(layoutHeight / page.height) * 100}%`,
    left: "50%",
    top: "50%",
    transform: `translate(-50%, -50%) rotate(${page.rotation}deg)`,
    width: `${(layoutWidth / page.width) * 100}%`,
  }
  const positionedSearchRects = useMemo(
    () =>
      searchMatches.flatMap(({ index, match }) =>
        match.rects.map((rect, rectIndex) => ({
          height: `${(rect.height / layoutHeight) * 100}%`,
          index,
          key: `${index}-${rectIndex}`,
          left: `${(rect.left / layoutWidth) * 100}%`,
          top: `${(rect.top / layoutHeight) * 100}%`,
          width: `${(rect.width / layoutWidth) * 100}%`,
        })),
      ),
    [layoutHeight, layoutWidth, searchMatches],
  )

  return (
    <>
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
        {hasRendered && positionedSearchRects.length > 0 ? (
          <div
            aria-hidden
            className="pdf-search-layer"
            style={pageLayerStyle}
          >
            {positionedSearchRects.map((rect) => (
              <span
                data-active={rect.index === activeSearchIndex}
                data-search-match={rect.index}
                key={rect.key}
                style={{
                  height: rect.height,
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                }}
              />
            ))}
          </div>
        ) : null}
        {hasRendered && positionedSpans.length > 0 ? (
          <PageTextMenu style={pageLayerStyle}>
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
          </PageTextMenu>
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
      {draft ? (
        <RectDraftOverlay
          draft={draft}
          pageWidth={page.width}
          rotation={rotation}
          sourceCanvasRef={canvasRef}
          sourceRevision={bitmapRevision}
        />
      ) : null}
    </>
  )
}

export function PdfPage({
  activeSearchIndex,
  documentId,
  draft,
  page,
  pageNumber,
  renderEpoch,
  renderScale,
  renderWidth,
  rotation,
  scale,
  searchMatches,
  textEpoch,
  virtualizationPaused,
  virtualizationRetainExited,
  width,
}: PdfPageProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const isNearViewport = useNearViewport(
    wrapperRef,
    "800px 0px",
    {
      paused: virtualizationPaused,
      retainExited: virtualizationRetainExited,
      retainSelection: true,
    },
  )

  // The user rotation spins the whole page (canvas + text layer) clockwise. It
  // is applied on top of the bitmap's displayed dimensions, so a 90°/270° user
  // rotation swaps the on-screen footprint the page occupies in the column.
  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, page.width, page.height)
  const displayWidth = width ?? footprintWidth * POINT_TO_PX * scale
  const targetRenderWidth =
    renderWidth ?? footprintWidth * POINT_TO_PX * renderScale

  return (
    <div
      aria-label={t("viewer.pageLabel", { pageNumber })}
      className="relative shrink-0 scroll-mt-5 overflow-hidden bg-white shadow-md ring-1 ring-black/10"
      data-page-number={pageNumber}
      data-rotation={rotation}
      ref={wrapperRef}
      style={{ aspectRatio: footprintWidth / footprintHeight, width: displayWidth }}
    >
      {isNearViewport ? (
        <PdfPageSurface
          activeSearchIndex={activeSearchIndex}
          documentId={documentId}
          draft={draft}
          footprintHeight={footprintHeight}
          footprintWidth={footprintWidth}
          page={page}
          pageNumber={pageNumber}
          renderEpoch={renderEpoch}
          renderWidth={targetRenderWidth}
          rotation={rotation}
          searchMatches={searchMatches}
          textEpoch={textEpoch}
        />
      ) : null}
    </div>
  )
}
