import { useState } from "react"
import { useTranslation } from "react-i18next"

import { OperationProgress } from "@/components/OperationProgress"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { useAnnotations } from "@/hooks/useAnnotations"
import { useExportDialogRun } from "@/hooks/useExportDialogRun"
import {
  DEFAULT_IMAGE_RESOLUTION,
  IMAGE_RESOLUTION_CHOICES,
  type ImageFormat,
  type ImageResolution,
} from "@/lib/archiveExport"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { parsePageRange } from "@/lib/pageRange"

const FORMAT_OPTIONS: Array<{
  format: ImageFormat
  labelKey: "imageExport.jpg" | "imageExport.png"
  hintKey: "imageExport.jpgHint" | "imageExport.pngHint"
}> = [
  { format: "jpg", labelKey: "imageExport.jpg", hintKey: "imageExport.jpgHint" },
  { format: "png", labelKey: "imageExport.png", hintKey: "imageExport.pngHint" },
]

const RESOLUTION_COPY: Record<
  ImageResolution,
  {
    labelKey:
      | "imageExport.resolutionHigh"
      | "imageExport.resolutionMedium"
      | "imageExport.resolutionLow"
    hintKey:
      | "imageExport.resolutionHighHint"
      | "imageExport.resolutionMediumHint"
      | "imageExport.resolutionLowHint"
  }
> = {
  high: {
    labelKey: "imageExport.resolutionHigh",
    hintKey: "imageExport.resolutionHighHint",
  },
  medium: {
    labelKey: "imageExport.resolutionMedium",
    hintKey: "imageExport.resolutionMediumHint",
  },
  low: {
    labelKey: "imageExport.resolutionLow",
    hintKey: "imageExport.resolutionLowHint",
  },
}

const RESOLUTION_OPTIONS = IMAGE_RESOLUTION_CHOICES.map((choice) => ({
  ...choice,
  ...RESOLUTION_COPY[choice.key],
}))

const DEFAULT_IMAGE_DPI =
  IMAGE_RESOLUTION_CHOICES.find((choice) => choice.key === DEFAULT_IMAGE_RESOLUTION)!.dpi

type ImageExportDialogProps = {
  document: PdfDocumentInfo
  /** Its tab is not the one showing: out of sight, with its state kept. */
  hidden?: boolean
  suggestedName: string
  onExport: ReturnType<typeof useAnnotations>["exportArchive"]
  onClose: () => void
}

export function ImageExportDialog({
  document,
  hidden = false,
  suggestedName,
  onExport,
  onClose,
}: ImageExportDialogProps) {
  const { t } = useTranslation()
  const [imageFormat, setImageFormat] = useState<ImageFormat>("jpg")
  const [resolution, setResolution] = useState<ImageResolution>(DEFAULT_IMAGE_RESOLUTION)
  const [pagesInput, setPagesInput] = useState("")
  const [failed, setFailed] = useState(false)
  const { busy, progress, requestStop, run, stopping } = useExportDialogRun(
    document.id,
    "cancel_pdf_archive",
  )
  const selection = parsePageRange(pagesInput, document.numPages)
  const selectionError =
    selection.kind === "invalid"
      ? t("imageExport.pagesInvalid")
      : selection.kind === "beyond"
        ? t("imageExport.pagesBeyond", {
            page: selection.page,
            total: document.numPages,
          })
        : undefined

  const start = async () => {
    const result = await run((onProgress) => {
      setFailed(false)
      const pages =
        selection.kind === "pages"
          ? selection.pages
          : Array.from({ length: document.numPages }, (_, index) => index + 1)
      const dpi =
        RESOLUTION_OPTIONS.find((option) => option.key === resolution)?.dpi ??
        DEFAULT_IMAGE_DPI

      return onExport(
        {
          options: { format: "images", imageFormat, dpi, pages },
          filterLabel: t("imageExport.filter"),
          suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${imageFormat}.zip`,
        },
        onProgress,
      )
    })

    if (!result.ran || result.outcome === "busy") return
    if (result.outcome === "failed") setFailed(true)
    else onClose()
  }

  return (
    <Dialog
      open={!hidden}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        data-testid="image-export-dialog"
        showCloseButton={!busy}
        aria-busy={busy}
        className="sm:max-w-[min(42rem,calc(100%-2rem))]"
      >
        <DialogHeader>
          <DialogTitle>{t("imageExport.title")}</DialogTitle>
          <DialogDescription>{t("imageExport.description")}</DialogDescription>
        </DialogHeader>
        {/* The format and range face the reader's choice, the resolutions
            their intent — two columns keep both above the fold together. */}
        <div className="grid grid-cols-2 items-start gap-6 py-2">
          <div className="grid content-start gap-4">
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t("imageExport.format")}</span>
              <RadioGroup
                aria-label={t("imageExport.format")}
                disabled={busy}
                value={imageFormat}
                onValueChange={(value) => setImageFormat(value as ImageFormat)}
                className="gap-4"
              >
                {FORMAT_OPTIONS.map((option) => (
                  <Label key={option.format} className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
                    <RadioGroupItem
                      value={option.format}
                      data-testid={`image-format-${option.format}`}
                    />
                    <span className="grid gap-1.5">
                      <span>{t(option.labelKey)}</span>
                      <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                        {t(option.hintKey)}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="image-export-pages">{t("imageExport.pages")}</Label>
              <Input
                id="image-export-pages"
                data-testid="image-pages-input"
                disabled={busy}
                aria-invalid={selectionError !== undefined}
                placeholder={t("imageExport.pagesPlaceholder")}
                value={pagesInput}
                onChange={(event) => setPagesInput(event.target.value)}
              />
              <p
                aria-live="polite"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {selectionError ?? t("imageExport.pagesHint")}
              </p>
            </div>
          </div>
          <div className="grid content-start gap-2">
            <span className="text-sm font-medium">{t("imageExport.resolution")}</span>
            <RadioGroup
              aria-label={t("imageExport.resolution")}
              disabled={busy}
              value={resolution}
              onValueChange={(value) => setResolution(value as ImageResolution)}
              className="gap-4"
            >
              {RESOLUTION_OPTIONS.map((option) => (
                <Label key={option.key} className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
                  <RadioGroupItem
                    value={option.key}
                    data-testid={`image-resolution-${option.key}`}
                  />
                  <span className="grid gap-1.5">
                    <span>{t(option.labelKey)}</span>
                    <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                      {t(option.hintKey)}
                    </span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </div>
        </div>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("imageExport.failed")}
          </p>
        ) : null}
        {busy ? (
          <OperationProgress
            label={t("imageExport.preparing")}
            progress={progress}
            testId="image-export-progress"
          />
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={stopping}
            onClick={() => {
              if (!busy) {
                onClose()
                return
              }
              requestStop()
            }}
            data-testid="image-export-cancel"
          >
            {t(
              stopping
                ? "imageExport.stopping"
                : busy
                  ? "imageExport.stop"
                  : "imageExport.cancel",
            )}
          </Button>
          <Button
            disabled={busy || selectionError !== undefined}
            onClick={() => void start()}
            data-testid="image-export-start"
          >
            {t("imageExport.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
