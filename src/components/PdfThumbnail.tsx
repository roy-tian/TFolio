import { useRef } from "react"
import { LoaderCircle, TriangleAlert } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useNearViewport } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import {
  dimensionsForRotation,
  MAX_THUMBNAIL_RENDER_WIDTH,
  type PdfPageInfo,
} from "@/lib/pdf"
import { cn } from "@/lib/utils"

// A thumbnail cell is a fraction of a page's height, so the page-sized prefetch
// margin would reach several rows past the viewport and burst dozens of renders
// through PDFium at once. Stay closer to the reader.
const THUMBNAIL_ROOT_MARGIN = "400px 0px"

type PdfThumbnailProps = {
  documentId: number
  isCurrent: boolean
  onSelect: (pageNumber: number) => void
  page: PdfPageInfo
  pageNumber: number
  rotation: number
  /** CSS pixels this thumbnail occupies; the grid sizes every cell alike. */
  width: number
}

/**
 * A page preview that navigates rather than reads: it paints a WebP bitmap and
 * deliberately carries no selectable text layer, so a grid of them stays cheap
 * even on a long document.
 */
export function PdfThumbnail({
  documentId,
  isCurrent,
  onSelect,
  page,
  pageNumber,
  rotation,
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
    page,
    pageNumber,
    rotation,
    targetWidth: width,
  })

  // The user rotation spins the preview clockwise, swapping the footprint a
  // quarter turn leaves behind.
  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, page.width, page.height)
  const label = t("viewer.thumbnailLabel", { pageNumber })

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        aria-current={isCurrent ? "page" : undefined}
        aria-label={label}
        className={cn(
          "relative block w-full scroll-mt-5 overflow-hidden bg-white shadow-md outline-none ring-1 ring-black/10 transition-shadow hover:ring-2 hover:ring-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50",
          isCurrent && "ring-2 ring-primary hover:ring-primary",
        )}
        data-page-number={pageNumber}
        onClick={() => onSelect(pageNumber)}
        ref={wrapperRef}
        style={{ aspectRatio: footprintWidth / footprintHeight }}
        title={label}
        type="button"
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
      <span
        className={cn(
          "font-mono text-xs tabular-nums",
          isCurrent ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {pageNumber}
      </span>
    </div>
  )
}
