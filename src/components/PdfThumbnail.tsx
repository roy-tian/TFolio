import { useLayoutEffect, useRef, useState } from "react"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { useNearViewport } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import { dimensionsForRotation, MAX_THUMBNAIL_RENDER_WIDTH } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

// An organize row holds many cells; preloading whole rows would queue dozens of
// PDFium renders at once. Keep the window to what is visible.
const THUMBNAIL_ROOT_MARGIN = "0px"

// The sidebar's previews stand in view beside the pages: ranked as this far
// off, they wait for the pages the reader is looking at rather than tie them.
const SIDEBAR_PRIORITY_BIAS = 2000

type PdfThumbnailProps = {
  documentId: number
  intrinsicRotation: number
  isCurrent: boolean
  /** Whether a cut is standing over this page: it is still here, and a paste
      is what would move it. */
  isCut: boolean
  isSelected: boolean
  onOpen: (pageNumber: number) => void
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  /** The page's size in points, taken apart rather than as a `PdfPageInfo`:
      every structure edit replaces the page list, and cells must compare equal. */
  pageHeight: number
  pageNumber: number
  pageWidth: number
  renderEpoch: number
  /** False once the cell is well away from the view: it gives its pixels back. */
  retainBitmap: boolean
  rotation: number
  /** The paper's long side in CSS pixels; the organize grid's size control. */
  paperWidth?: number
  /** The sidebar's previews and the organize grid's sit beside, or above, the
      pages a viewer shows, so they never answer to `data-page-number`, which
      finds those pages. An organize preview names a source's page. */
  surface: "sidebar" | "organize"
  /** Overrides the surface's own wording, for a page that is not this
      document's — an organize source's. */
  label?: string
  /** The number under the paper, where it is not the page's own: an organize
      preview shows where the page will stand. */
  caption?: number
}

/** A preview that selects rather than reads — no text layer, so a long column
    stays cheap. Its page menu belongs to the owner: `SidebarThumbnails`,
    `OrganizeBoard`. */
export function PdfThumbnail({
  documentId,
  intrinsicRotation,
  isCurrent,
  isCut,
  isSelected,
  onOpen,
  onSelect,
  pageHeight,
  pageNumber,
  pageWidth,
  renderEpoch,
  retainBitmap,
  rotation,
  paperWidth,
  surface,
  label: labelOverride,
  caption,
}: PdfThumbnailProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const spinRef = useRef<HTMLDivElement>(null)
  const isNearViewport = useNearViewport(wrapperRef, THUMBNAIL_ROOT_MARGIN)
  const page = { height: pageHeight, rotation: intrinsicRotation, width: pageWidth }
  const isPage = (other: typeof page) =>
    other.height === pageHeight &&
    other.width === pageWidth &&
    other.rotation === intrinsicRotation
  // The page as the canvas holds it. The paper takes the page's new size at
  // once, as the layout around it does; until the replacement is painted,
  // these pixels are turned and fitted to it rather than stretched.
  const [paintedPage, setPaintedPage] = useState(page)
  const shownPageRef = useRef(paintedPage)

  const { hasRendered, renderFailed } = usePageBitmap({
    canvasRef,
    command:
      surface === "organize"
        ? "render_organize_thumbnail"
        : "render_pdf_page_thumbnail",
    documentId,
    idArgument: surface === "organize" ? "sourceId" : "documentId",
    isNearViewport,
    maxRenderWidth: MAX_THUMBNAIL_RENDER_WIDTH,
    mimeType: "image/webp",
    onPaint: () =>
      setPaintedPage((previous) => (isPage(previous) ? previous : page)),
    pageHeight,
    pageNumber,
    pageWidth,
    priorityBias: surface === "sidebar" ? SIDEBAR_PRIORITY_BIAS : 0,
    renderEpoch,
    retainBitmap,
    // The bitmap is drawn upright and a turn keeps the thumbnail's scale, so its
    // upright width serves every rotation and a turn needs no fresh render. The
    // page as it now measures, not as last painted: this sizes the replacement.
    rotation: 0,
    targetWidth: thumbnailPaper({ height: pageHeight, width: pageWidth }, paperWidth)
      .width,
  })

  // With no bitmap on show no pixels need the old geometry: the next paint
  // then lands upright, not turned a second time until React catches up.
  if (!hasRendered && !isPage(paintedPage)) {
    setPaintedPage(page)
  }

  useLayoutEffect(() => {
    const previous = shownPageRef.current
    shownPageRef.current = {
      height: pageHeight,
      rotation: intrinsicRotation,
      width: pageWidth,
    }
    const paper = wrapperRef.current
    const spinner = spinRef.current
    const turn = ((intrinsicRotation - previous.rotation + 540) % 360) - 180

    if (
      !hasRendered ||
      !turn ||
      !paper ||
      !spinner ||
      paper.getClientRects().length === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return
    }

    // Relative, so the replacement landing mid-turn — already turned by PDFium,
    // its static transform dropping the turn — carries on the same spin.
    const timing = { duration: 250, easing: "ease-out" }
    const spin = spinner.animate(
      [{ transform: `rotate(${-turn}deg)` }, { transform: "rotate(0deg)" }],
      timing,
    )
    const oldPaper = thumbnailPaper(
      dimensionsForRotation(rotation, previous.width, previous.height),
      paperWidth,
    )
    const newPaper = thumbnailPaper(
      dimensionsForRotation(rotation, pageWidth, pageHeight),
      paperWidth,
    )
    const resize = paper.animate(
      [
        { height: `${oldPaper.height}px`, width: `${oldPaper.width}px` },
        { height: `${newPaper.height}px`, width: `${newPaper.width}px` },
      ],
      timing,
    )

    return () => {
      spin.cancel()
      resize.cancel()
    }
  }, [hasRendered, intrinsicRotation, pageHeight, pageWidth, rotation])

  // The user rotation spins the preview clockwise, swapping the footprint a
  // quarter turn leaves behind.
  const paperSize = thumbnailPaper(
    dimensionsForRotation(rotation, pageWidth, pageHeight),
    paperWidth,
  )
  // Pixels painted before an edit turned or resized the page: a turn keeps the
  // scale, so they fit exactly once turned along; a resize letterboxes them.
  const pendingTurn = (intrinsicRotation - paintedPage.rotation + 360) % 360
  const preview = thumbnailPaper(paintedPage, paperWidth)
  const previewFootprint = dimensionsForRotation(
    (rotation + pendingTurn) % 360,
    preview.width,
    preview.height,
  )
  const previewFit = Math.min(
    paperSize.width / previewFootprint.width,
    paperSize.height / previewFootprint.height,
  )
  const label = labelOverride ?? t("sidebar.thumbnailLabel", { pageNumber })

  return (
    <div
      className={cn(
        "group/thumb flex flex-col items-center transition-opacity",
        // Faded, the way a file manager marks a cut: the page is still here,
        // and a paste is what moves it.
        isCut && "opacity-45",
      )}
    >
      <div className="relative">
        {/* A page that could not be drawn says so instead: the paper is a white
            card with a warning in it, and the reason is what a hover owes it.
            Otherwise the caption speaks: hundreds of tooltips would slow every
            long document. */}
        <HintTooltip
          label={renderFailed ? t("viewer.pageError", { pageNumber }) : undefined}
        >
          <button
            aria-current={isCurrent ? "page" : undefined}
            aria-label={label}
            aria-pressed={isSelected}
            className={cn(
              "relative block scroll-mt-5 bg-white shadow-md outline-none ring-1 ring-black/10 transition-shadow hover:ring-2 hover:ring-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50",
              // The current page keeps its marker, faded: the selection is the
              // louder voice.
              isCurrent && "ring-2 ring-primary/40 hover:ring-primary/40",
              // Offset from the page, so the ring reads against the page's own
              // white even when the theme paints the ring light. The last page
              // clicked keeps focus, and WebKitGTK may show its focus ring, which
              // would grey that one page out of the selection's.
              isSelected &&
                "ring-2 ring-primary ring-offset-2 ring-offset-zinc-200/70 hover:ring-primary focus-visible:ring-2 focus-visible:ring-primary dark:ring-offset-zinc-950",
            )}
            data-thumbnail-page={pageNumber}
            data-rotation={rotation}
            onClick={(event) =>
              onSelect(pageNumber, {
                range: event.shiftKey,
                toggle: event.ctrlKey || event.metaKey,
              })
            }
            onDoubleClick={() => onOpen(pageNumber)}
            ref={wrapperRef}
            style={{ height: paperSize.height, width: paperSize.width }}
            type="button"
          >
            <div className="absolute inset-0" ref={spinRef}>
              <div
                className="absolute"
                style={{
                  height: preview.height,
                  left: "50%",
                  top: "50%",
                  transform: `translate(-50%, -50%) rotate(${rotation + pendingTurn}deg) scale(${previewFit})`,
                  width: preview.width,
                }}
              >
                <canvas
                  className="block h-full w-full"
                  height={1}
                  ref={canvasRef}
                  width={1}
                />
              </div>
            </div>
            {!hasRendered && !renderFailed ? (
              <span className="absolute inset-0 grid place-items-center bg-white text-zinc-400">
                {/* Only where a render is on its way: every spinning icon is
                    style and paint work each frame, and a long document's previews
                    would otherwise spin hundreds of them out of sight. */}
                {isNearViewport ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : null}
              </span>
            ) : null}
            {renderFailed ? (
              <span className="absolute inset-0 grid place-items-center bg-white text-zinc-500">
                <TriangleAlert className="size-4" />
              </span>
            ) : null}
          </button>
        </HintTooltip>
      </div>
      <span
        className={cn(
          "flex items-end font-mono text-xs tabular-nums",
          isCurrent ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
        style={{ height: THUMBNAIL_CAPTION_HEIGHT }}
      >
        {caption ?? pageNumber}
      </span>
    </div>
  )
}
