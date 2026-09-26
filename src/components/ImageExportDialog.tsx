import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"

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
import type { ImageFormat } from "@/lib/archiveExport"
import { IMAGE_DPI_CHOICES } from "@/lib/archiveExport"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { parsePageRange } from "@/lib/pageRange"
import type { PdfProgress } from "@/lib/progress"

const FORMAT_OPTIONS: Array<{
  format: ImageFormat
  labelKey: "imageExport.jpg" | "imageExport.png"
  hintKey: "imageExport.jpgHint" | "imageExport.pngHint"
}> = [
  { format: "jpg", labelKey: "imageExport.jpg", hintKey: "imageExport.jpgHint" },
  { format: "png", labelKey: "imageExport.png", hintKey: "imageExport.pngHint" },
]

const DPI_OPTIONS = IMAGE_DPI_CHOICES.map((dpi) => ({
  dpi,
  hintKey: `imageExport.dpiHint${dpi}` as `imageExport.dpiHint${typeof dpi}`,
}))

const DEFAULT_DPI = 150

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
  const [dpi, setDpi] = useState<number>(DEFAULT_DPI)
  const [pagesInput, setPagesInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const stopRequested = useRef(false)
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

  const cancel = async () => {
    if (await invoke<boolean>("cancel_pdf_archive", { documentId: document.id }).catch(() => false)) {
      stopRequested.current = false
    }
  }

  const start = async () => {
    setBusy(true)
    setFailed(false)
    setProgress(null)
    stopRequested.current = false
    const pages =
      selection.kind === "pages"
        ? selection.pages
        : Array.from({ length: document.numPages }, (_, index) => index + 1)
    const outcome = await onExport({
      options: { format: "images", imageFormat, dpi, pages },
      filterLabel: t("imageExport.filter"),
      suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${imageFormat}.zip`,
    }, (next) => {
      setProgress(next)
      if (stopRequested.current) void cancel()
    })
    setBusy(false)
    setStopping(false)
    if (outcome === "failed") setFailed(true)
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
        className="sm:max-w-2xl"
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
            <span className="text-sm font-medium">{t("imageExport.dpi")}</span>
            <RadioGroup
              aria-label={t("imageExport.dpi")}
              disabled={busy}
              value={String(dpi)}
              onValueChange={(value) => setDpi(Number(value))}
              className="gap-4"
            >
              {DPI_OPTIONS.map((option) => (
                <Label key={option.dpi} className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
                  <RadioGroupItem
                    value={String(option.dpi)}
                    data-testid={`image-dpi-${option.dpi}`}
                  />
                  <span className="grid gap-1.5">
                    <span>{option.dpi} dpi</span>
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
              stopRequested.current = true
              setStopping(true)
              void cancel()
            }}
            data-testid="image-export-cancel"
          >
            {t(stopping ? "imageExport.stopping" : "imageExport.cancel")}
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
