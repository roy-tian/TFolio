import { memo, useContext, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PageTextMenu } from "@/components/PageTextMenu"
import { RectDraftOverlay } from "@/components/RectDraftOverlay"
import { TextNotePreview } from "@/components/TextNotePreview"
import { useNearViewport, ViewportHoldContext } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import { useSelectionBands } from "@/hooks/useSelectionBands"
import type { RectDraft } from "@/hooks/useRectTool"
import type { TextNotePreview as HeldNote } from "@/hooks/useTextNoteTool"
import { mergeRectsByLine } from "@/lib/annotationGeometry"
import { cachedPageText, rememberPageText } from "@/lib/pageText"
import { distanceFromView, pageWork } from "@/lib/pageWork"
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

// The text layer renders every span in the font that measured its run width,
// so the horizontal scale stays consistent between measurement and layout.
const TEXT_LAYER_FONT_FAMILY = "sans-serif"

let measureContext: CanvasRenderingContext2D | null = null

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
  /** Live and released rectangles awaiting this page's pixels: its own only. */
  drafts: RectDraft[]
  /** Written notes awaiting this page's pixels: its own only. */
  notes: HeldNote[]
  /** Present only while a select-all stands: the page's menu then offers the
      whole document, which is what is selected, and not this page alone. */
  onCopyAllText?: () => void
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  page: PdfPageInfo
  pageNumber: number
  renderEpoch: number
  /** Viewer-level settled zoom used only to choose the bitmap resolution. */
  renderScale: number
  searchMatches: IndexedSearchMatch[]
  textEpoch: number
  /** The app's own select-all stands: its bands paint here, not per-span. */
  textSelectAll: boolean
  rotation: number
  scale: number
  /** CSS pixels to lay the page out at, overriding `scale` — only for a layout
      sharing one column across pages of different sizes, as a book spread. */
  width?: number
  renderWidth?: number
}

type PdfPageSurfaceProps = {
  activeSearchIndex: number | null
  documentId: number
  drafts: RectDraft[]
  notes: HeldNote[]
  onCopyAllText?: () => void
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  footprintHeight: number
  footprintWidth: number
  page: PdfPageInfo
  pageNumber: number
  renderEpoch: number
  renderWidth: number
  rotation: number
  searchMatches: IndexedSearchMatch[]
  textEpoch: number
  textSelectAll: boolean
}

/** Exists only around the viewport: leaving a page releases its canvas backing
    store, extracted text, and annotation preview instead of retaining them. */
const PdfPageSurface = memo(function PdfPageSurface({
  activeSearchIndex,
  documentId,
  drafts,
  notes,
  onCopyAllText,
  onPagePaint,
  footprintHeight,
  footprintWidth,
  page,
  pageNumber,
  renderEpoch,
  renderWidth,
  rotation,
  searchMatches,
  textEpoch,
  textSelectAll,
}: PdfPageSurfaceProps) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
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
    onPaint: onPagePaint,
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
    const cached = cachedPageText(documentId, pageNumber, textEpoch)

    if (cached) {
      setTextSpans(cached)
      return
    }

    let cancelled = false
    const leaving = new AbortController()
    // A text epoch means these spans no longer describe the page's selectable
    // content; do not leave stale runs clickable while PDFium extracts anew.
    setTextSpans([])

    // Just behind its own page's render, ahead of any page further away.
    void pageWork
      .schedule(
        () =>
          invoke<PdfTextSpan[]>("extract_pdf_page_text", {
            documentId,
            pageNumber,
          }),
        {
          priority: () => distanceFromView(surfaceRef.current) + 1,
          signal: leaving.signal,
        },
      )
      .then((spans) => {
        rememberPageText(documentId, pageNumber, textEpoch, spans)

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
      leaving.abort()
    }
  }, [documentId, pageNumber, textEpoch])

  // Spans are in the page's unrotated space; for 90°/270° the dimensions are
  // swapped and the layer itself is rotated to line back up with the bitmap.
  const { height: layoutHeight, width: layoutWidth } = dimensionsForRotation(
    page.rotation,
    page.width,
    page.height,
  )

  // Positions are page-relative and scale is resolution-independent, so only
  // the spans themselves — not a resize — call for recomputing this.
  const positionedSpans = useMemo(
    () =>
      textSpans.map((span) => {
        const naturalWidth = measureTextWidth(span.text, span.height)
        const scaleX = naturalWidth > 0 ? span.width / naturalWidth : 1

        return {
          fontSize: span.height,
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
        // Merged per match, so a hit reads as one mark a line — a gap the
        // page's spacing left between runs is inside the hit, not a slit —
        // while its cross-line boxes stay one per line.
        mergeRectsByLine(match.rects).map((rect, rectIndex) => ({
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
  const selectionBands = useSelectionBands({
    anchorRef: surfaceRef,
    page,
    rotation,
    selectAll: textSelectAll,
    spans: textSpans,
  })

  return (
    <>
      <div
        className="absolute"
        ref={surfaceRef}
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
          data-rendered={hasRendered}
          height={Math.max(1, Math.round(page.height))}
          ref={canvasRef}
          width={Math.max(1, Math.round(page.width))}
        />
        {notes.length > 0 ? (
          <div className="pointer-events-none absolute" style={pageLayerStyle}>
            {notes.map((note) => (
              <TextNotePreview
                key={note.id}
                layoutHeight={layoutHeight}
                layoutWidth={layoutWidth}
                note={note}
              />
            ))}
          </div>
        ) : null}
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
        {hasRendered && selectionBands.length > 0 ? (
          <div
            aria-hidden
            className="pdf-selection-layer"
            style={pageLayerStyle}
          >
            {selectionBands.map((band, index) => (
              <span
                key={index}
                style={{
                  height: `${(band.height / layoutHeight) * 100}%`,
                  left: `${(band.left / layoutWidth) * 100}%`,
                  top: `${(band.top / layoutHeight) * 100}%`,
                  width: `${(band.width / layoutWidth) * 100}%`,
                }}
              />
            ))}
          </div>
        ) : null}
        {hasRendered && positionedSpans.length > 0 ? (
          <PageTextMenu onCopyAll={onCopyAllText} style={pageLayerStyle}>
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
      {drafts.map((draft) => (
        <RectDraftOverlay
          draft={draft}
          key={draft.id}
          pageWidth={page.width}
          rotation={rotation}
          sourceCanvasRef={canvasRef}
          sourceRevision={bitmapRevision}
        />
      ))}
    </>
  )
})

export const PdfPage = memo(function PdfPage({
  activeSearchIndex,
  documentId,
  drafts,
  notes,
  onCopyAllText,
  onPagePaint,
  page,
  pageNumber,
  renderEpoch,
  renderScale,
  renderWidth,
  rotation,
  scale,
  searchMatches,
  textEpoch,
  textSelectAll,
  width,
}: PdfPageProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const isNearViewport = useNearViewport(wrapperRef, "800px 0px", {
    hold: useContext(ViewportHoldContext),
    retainSelection: true,
  })

  // User rotation spins the whole page clockwise on top of the bitmap's own
  // rotation, so a 90°/270° page swaps the footprint it takes in the column.
  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, page.width, page.height)
  const displayWidth = width ?? footprintWidth * POINT_TO_PX * scale
  const targetRenderWidth =
    renderWidth ?? footprintWidth * POINT_TO_PX * renderScale
  const surfaceScale = displayWidth / footprintWidth

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
        <div
          className="absolute left-0 top-0 origin-top-left"
          data-pdf-page-surface
          // Fixed page coordinates avoid laying out every text span on resize.
          // Canvas, selection, search and draft marks share the same transform.
          style={{
            height: footprintHeight,
            transform: `scale3d(${surfaceScale}, ${surfaceScale}, 1)`,
            width: footprintWidth,
          }}
        >
          <PdfPageSurface
            activeSearchIndex={activeSearchIndex}
            documentId={documentId}
            drafts={drafts}
            notes={notes}
            onCopyAllText={onCopyAllText}
            onPagePaint={onPagePaint}
            footprintHeight={footprintHeight}
            footprintWidth={footprintWidth}
            page={page}
            pageNumber={pageNumber}
            renderEpoch={renderEpoch}
            renderWidth={targetRenderWidth}
            rotation={rotation}
            searchMatches={searchMatches}
            textEpoch={textEpoch}
            textSelectAll={textSelectAll}
          />
        </div>
      ) : null}
    </div>
  )
})
