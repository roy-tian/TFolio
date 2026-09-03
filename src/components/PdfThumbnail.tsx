import { useRef } from "react"
import { LoaderCircle, TriangleAlert, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useNearViewport } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import { dimensionsForRotation, MAX_THUMBNAIL_RENDER_WIDTH } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT } from "@/lib/viewMode"

// A thumbnail cell is a fraction of a page's height, so the page-sized prefetch
// margin would reach several rows past the viewport and burst dozens of renders
// through PDFium at once. Stay closer to the reader.
const THUMBNAIL_ROOT_MARGIN = "400px 0px"

type PdfThumbnailProps = {
  /** Whether the keep-one-page rule forbids this delete — the sole page, or a
      selection this page belongs to that spans the whole document. */
  deleteDisabled: boolean
  documentId: number
  isCurrent: boolean
  isSelected: boolean
  onDelete: (pageNumber: number) => void
  /** Double-click: leave the grid for the page itself. */
  onOpen: (pageNumber: number) => void
  /** Single click, with its modifiers, is selection. */
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  /** The page's displayed size in points, taken apart rather than as a
      `PdfPageInfo`: every structure edit replaces the whole page list, and a
      cell whose own page did not change must still compare equal. */
  pageHeight: number
  pageNumber: number
  pageWidth: number
  /** Bumped when the page is drawn on, so the bitmap is fetched again. */
  renderEpoch: number
  rotation: number
  /** How many pages the whole selection holds, for the delete label. */
  selectedCount: number
  /** CSS pixels this thumbnail occupies; the grid sizes every cell alike. */
  width: number
}

/**
 * A page preview that selects rather than reads: it paints a WebP bitmap and
 * deliberately carries no selectable text layer, so a grid of them stays cheap
 * even on a long document. A click selects, a double-click opens the page, and
 * the corner button deletes — the current selection when this page is in it,
 * this page alone otherwise.
 */
export function PdfThumbnail({
  deleteDisabled,
  documentId,
  isCurrent,
  isSelected,
  onDelete,
  onOpen,
  onSelect,
  pageHeight,
  pageNumber,
  pageWidth,
  renderEpoch,
  rotation,
  selectedCount,
  width,
}: PdfThumbnailProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isNearViewport = useNearViewport(wrapperRef, THUMBNAIL_ROOT_MARGIN)

  const { hasRendered, renderFailed } = usePageBitmap({
    canvasRef,
    command: "render_pdf_page_thumbnail",
    documentId,
    isNearViewport,
    maxRenderWidth: MAX_THUMBNAIL_RENDER_WIDTH,
    mimeType: "image/webp",
    pageHeight,
    pageNumber,
    pageWidth,
    renderEpoch,
    rotation,
    targetWidth: width,
  })

  // The user rotation spins the preview clockwise, swapping the footprint a
  // quarter turn leaves behind.
  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, pageWidth, pageHeight)
  const label = t("viewer.thumbnailLabel", { pageNumber })
  const deletesSelection = isSelected && selectedCount > 1
  const deleteLabel = deletesSelection
    ? t("pageEdit.deleteSelected", { count: selectedCount })
    : t("pageEdit.deletePage", { pageNumber })

  return (
    <div className="group/thumb relative flex flex-col items-center">
      <button
        aria-current={isCurrent ? "page" : undefined}
        aria-label={label}
        aria-pressed={isSelected}
        className={cn(
          "relative block w-full scroll-mt-5 overflow-hidden bg-white shadow-md outline-none ring-1 ring-black/10 transition-shadow hover:ring-2 hover:ring-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50",
          // The current page keeps its marker, faded: in the editing grid the
          // selection is the louder voice.
          isCurrent && "ring-2 ring-primary/40 hover:ring-primary/40",
          // Offset from the page, so the ring reads against the page's own
          // white even when the theme paints the ring light.
          isSelected &&
            "ring-2 ring-primary ring-offset-2 ring-offset-zinc-200/70 hover:ring-primary dark:ring-offset-zinc-950",
        )}
        data-page-number={pageNumber}
        onClick={(event) =>
          onSelect(pageNumber, {
            range: event.shiftKey,
            toggle: event.ctrlKey || event.metaKey,
          })
        }
        onDoubleClick={() => onOpen(pageNumber)}
        ref={wrapperRef}
        style={{ aspectRatio: footprintWidth / footprintHeight }}
        title={label}
        type="button"
      >
        <div
          className="absolute"
          style={{
            height: `${(pageHeight / footprintHeight) * 100}%`,
            left: "50%",
            top: "50%",
            transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            width: `${(pageWidth / footprintWidth) * 100}%`,
          }}
        >
          <canvas
            className="block h-full w-full"
            height={Math.max(1, Math.round(pageHeight))}
            ref={canvasRef}
            width={Math.max(1, Math.round(pageWidth))}
          />
        </div>
        {!hasRendered && !renderFailed ? (
          <span className="absolute inset-0 grid place-items-center bg-white text-zinc-400">
            <LoaderCircle className="size-4 animate-spin" />
          </span>
        ) : null}
        {renderFailed ? (
          <span
            className="absolute inset-0 grid place-items-center bg-white text-zinc-500"
            title={t("viewer.pageError", { pageNumber })}
          >
            <TriangleAlert className="size-4" />
          </span>
        ) : null}
      </button>
      <button
        aria-label={deleteLabel}
        className={cn(
          "absolute -left-2 -top-2 z-20 grid size-6 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-0",
          // No hover on a touch screen, so a selected page shows its button.
          isSelected
            ? "opacity-100"
            : "opacity-0 group-hover/thumb:opacity-100",
        )}
        disabled={deleteDisabled}
        onClick={() => onDelete(pageNumber)}
        // A press here is a press on the button, never the start of a page
        // drag under it.
        onPointerDown={(event) => event.stopPropagation()}
        title={deleteLabel}
        type="button"
      >
        <X className="size-3.5" />
      </button>
      {/* The space over the number is the caption's own box rather than the
          column's gap, so what the number costs the cell is one known height —
          which is what lets the insertion line beside the cell find the paper
          in a row taller than it. */}
      <span
        className={cn(
          "flex items-end font-mono text-xs tabular-nums",
          isCurrent ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
        style={{ height: THUMBNAIL_CAPTION_HEIGHT }}
      >
        {pageNumber}
      </span>
    </div>
  )
}
