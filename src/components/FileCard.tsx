import { useRef } from "react"
import { LoaderCircle, TriangleAlert, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useNearViewport } from "@/hooks/useNearViewport"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import type { FileRange } from "@/lib/fileRanges"
import {
  dimensionsForRotation,
  MAX_THUMBNAIL_RENDER_WIDTH,
  type PdfPageInfo,
} from "@/lib/pdf"
import { cn } from "@/lib/utils"

const THUMBNAIL_ROOT_MARGIN = "400px 0px"
// Cards fanned behind the front leaf, at most this many — enough to read as a
// stack without a render each: they are bare paper, not page previews.
const MAX_FAN = 3

type FileCardProps = {
  /** Disabled when this is the only file — the document must keep a page. */
  deleteDisabled: boolean
  documentId: number
  onDelete: (range: FileRange) => void
  /** The range's first page, whose thumbnail is the card's face. */
  page: PdfPageInfo
  /** 1-based position of the card among the files, for the drag gesture. */
  position: number
  range: FileRange
  /** Bumped when the face page is drawn on, so its bitmap is fetched again. */
  renderEpoch: number
  rotation: number
  /** CSS pixels the card's face occupies. */
  width: number
}

/**
 * One file as a card: its first page as the face, fanned behind by a few bare
 * leaves for a multi-page file so the stack reads as thicker than a single
 * sheet. The whole card is one drag handle for reordering files; the corner
 * button removes the file (its whole page range). A "file" is only the
 * frontend's accounting of a page range — see `fileRanges`.
 */
export function FileCard({
  deleteDisabled,
  documentId,
  onDelete,
  page,
  position,
  range,
  renderEpoch,
  rotation,
  width,
}: FileCardProps) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
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
    // The file's first real page is the card's face — never a pad that a
    // page-level edit may have left leading the run (`range.start`).
    pageNumber: range.firstReal,
    renderEpoch,
    rotation,
    targetWidth: width,
  })

  const { height: footprintHeight, width: footprintWidth } =
    dimensionsForRotation(rotation, page.width, page.height)
  const fanCount = Math.min(range.pageCount - 1, MAX_FAN)
  const label = t("files.cardLabel", { name: range.name })
  const deleteLabel = t("files.deleteFile", { name: range.name })
  const pageCountLabel =
    range.padAt.length > 0
      ? t("files.pageCountPadded", {
          count: range.pageCount,
          pad: range.padAt.length,
        })
      : t("files.pageCount", { count: range.pageCount })

  return (
    <div className="group/card flex flex-col items-center gap-2">
      <div
        aria-label={label}
        className="relative cursor-grab active:cursor-grabbing"
        data-file-index={position}
        ref={wrapperRef}
        style={{ width, aspectRatio: footprintWidth / footprintHeight }}
        title={label}
      >
        {/* Bare leaves peeking out to the upper right of the face, so the stack
            reads as thicker without dipping into the caption below — style only,
            no render, so a long file stays as cheap as a short one. Behind by
            DOM order, not a negative z-index, which would sink them below the
            page background; rendered back-to-front so the outermost sits deepest. */}
        {Array.from({ length: fanCount }, (_, index) => {
          const depth = fanCount - index

          return (
            <div
              aria-hidden
              className="absolute inset-0 rounded-[2px] border border-black/10 bg-white shadow-sm"
              data-fan-leaf
              key={index}
              style={{
                transform: `translate(${depth * 7}px, ${depth * -5}px) rotate(${depth * 2.5}deg)`,
                transformOrigin: "center",
              }}
            />
          )
        })}
        <div
          className={cn(
            "relative block size-full overflow-hidden rounded-[2px] bg-white shadow-md ring-1 ring-black/10 transition-shadow",
            "group-hover/card:ring-2 group-hover/card:ring-foreground/30",
          )}
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
              className="block size-full"
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
              title={t("viewer.pageError", { pageNumber: range.firstReal })}
            >
              <TriangleAlert className="size-4" />
            </span>
          ) : null}
        </div>
        <button
          aria-label={deleteLabel}
          className={cn(
            "absolute -right-2 -top-2 z-10 grid size-6 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm outline-none transition-opacity hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-0",
            "opacity-0 group-hover/card:opacity-100",
          )}
          disabled={deleteDisabled}
          onClick={() => onDelete(range)}
          // A press on the button is not the start of a card drag under it.
          onPointerDown={(event) => event.stopPropagation()}
          title={deleteLabel}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex max-w-full flex-col items-center gap-0.5">
        <span className="max-w-full truncate text-sm font-medium" title={range.name}>
          {range.name}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {pageCountLabel}
        </span>
      </div>
    </div>
  )
}
