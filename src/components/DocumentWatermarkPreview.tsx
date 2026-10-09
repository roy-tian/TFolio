import { ChevronLeft, ChevronRight, LoaderCircle, TriangleAlert } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { WatermarkPreview } from "@/components/WatermarkPreview"
import { Button } from "@/components/ui/button"
import { usePageBitmap } from "@/hooks/usePageBitmap"
import type { RenderEpochs } from "@/lib/annotations"
import {
  MAX_THUMBNAIL_RENDER_WIDTH,
  type PdfDocumentInfo,
  type PdfPageInfo,
} from "@/lib/pdf"
import type { WatermarkConfig } from "@/lib/watermark"

function PageThumbnail({
  documentId,
  page,
  pageNumber,
  renderEpoch,
}: {
  documentId: number
  page: PdfPageInfo
  pageNumber: number
  renderEpoch: number
}) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { hasRendered, renderFailed } = usePageBitmap({
    canvasRef,
    command: "render_pdf_watermark_preview",
    documentId,
    isNearViewport: true,
    maxRenderWidth: MAX_THUMBNAIL_RENDER_WIDTH,
    mimeType: "image/webp",
    pageHeight: page.height,
    pageNumber,
    pageWidth: page.width,
    renderEpoch,
    rotation: 0,
    targetWidth: 224,
  })

  return (
    <>
      <canvas
        aria-label={t("viewer.pageLabel", { pageNumber })}
        className="absolute inset-0 size-full"
        data-testid="watermark-thumbnail"
        data-ready={hasRendered}
        ref={canvasRef}
        role="img"
      />
      {renderFailed ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-white text-destructive"
          role="alert"
        >
          <TriangleAlert
            aria-label={t("viewer.pageError", { pageNumber })}
            className="size-5"
          />
        </div>
      ) : !hasRendered ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-white text-muted-foreground"
          role="status"
        >
          <LoaderCircle
            aria-label={t("watermark.previewLoading")}
            className="size-5 animate-spin"
          />
        </div>
      ) : null}
    </>
  )
}

export type DocumentWatermarkPreviewProps = {
  config: WatermarkConfig
  document: PdfDocumentInfo
  initialPage: number
  renderEpochs: RenderEpochs
}

export function DocumentWatermarkPreview({
  config,
  document,
  initialPage,
  renderEpochs,
}: DocumentWatermarkPreviewProps) {
  const { t } = useTranslation()
  const [selectedPage, setSelectedPage] = useState(initialPage)
  const pageNumber = Math.max(1, Math.min(selectedPage, document.pages.length))
  const page = document.pages[pageNumber - 1]

  if (!page) {
    return null
  }

  const buttonClass = "pointer-events-auto absolute top-1/2 -translate-y-1/2 rounded-full shadow-md"

  return (
    <div className="flex flex-col gap-2">
      <div className="group/preview relative" data-testid="watermark-page-preview">
        <WatermarkPreview
          config={config}
          page={page}
          placeholder={t("watermark.previewPlaceholder")}
        >
          {/* Remount for each page so an in-flight render cannot paint the
              previous page beneath the new page's watermark geometry. */}
          <PageThumbnail
            documentId={document.id}
            key={`${document.id}:${pageNumber}`}
            page={page}
            pageNumber={pageNumber}
            renderEpoch={renderEpochs[pageNumber] ?? 0}
          />
        </WatermarkPreview>
        {document.pages.length > 1 ? (
          <div className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity group-hover/preview:opacity-100 group-focus-within/preview:opacity-100 [@media(hover:none)]:opacity-100">
            <Button
              aria-label={t("watermark.previousPage")}
              className={`${buttonClass} left-2`}
              data-testid="watermark-previous-page"
              disabled={pageNumber === 1}
              onClick={() => setSelectedPage(pageNumber - 1)}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <ChevronLeft />
            </Button>
            <Button
              aria-label={t("watermark.nextPage")}
              className={`${buttonClass} right-2`}
              data-testid="watermark-next-page"
              disabled={pageNumber === document.pages.length}
              onClick={() => setSelectedPage(pageNumber + 1)}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <ChevronRight />
            </Button>
          </div>
        ) : null}
      </div>
      <p
        aria-live="polite"
        className="text-center text-xs text-muted-foreground"
        data-testid="watermark-page-number"
      >
        {t("watermark.previewPage", {
          page: pageNumber,
          total: document.pages.length,
        })}
      </p>
    </div>
  )
}
