import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"

import { OperationProgress } from "@/components/OperationProgress"
import { SliderRow } from "@/components/SliderRow"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { useAnnotations } from "@/hooks/useAnnotations"
import {
  MAX_JPEG_QUALITY,
  MIN_JPEG_QUALITY,
  RASTER_DPI_CHOICES,
  type CompressionEstimate,
  type CompressionOptions,
} from "@/lib/compressExport"
import { formatBytes } from "@/lib/formatBytes"
import type { PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

const DEFAULT_DPI = 150
const DEFAULT_QUALITY = 75
/** Long enough for a slider drag to settle, short enough to feel live. */
const ESTIMATE_DEBOUNCE_MS = 300

type CompressMode = "lossless" | "rasterized"

type CompressExportDialogProps = {
  document: PdfDocumentInfo
  suggestedName: string
  onExport: ReturnType<typeof useAnnotations>["exportCompressed"]
  onClose: () => void
}

export function CompressExportDialog({
  document,
  suggestedName,
  onExport,
  onClose,
}: CompressExportDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<CompressMode>("lossless")
  const [dpi, setDpi] = useState(DEFAULT_DPI)
  const [quality, setQuality] = useState(DEFAULT_QUALITY)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const [estimate, setEstimate] = useState<CompressionEstimate | null>(null)
  const [estimating, setEstimating] = useState(true)
  const [estimateFailed, setEstimateFailed] = useState(false)
  const stopRequested = useRef(false)
  // An export must outlive this dialog: it shares the estimate's cancel
  // target, so a cancel sent from an unmounting dialog would kill it between
  // pages with nothing mounted left to report that.
  const exportingRef = useRef(false)
  // Only the newest estimate may answer: a slower run for abandoned levels
  // must not overwrite the one the reader is looking at.
  const estimateRun = useRef(0)

  const options: CompressionOptions =
    mode === "lossless"
      ? { mode: "lossless" }
      : { mode: "rasterized", dpi, quality }

  /** Stops any estimate still running for superseded levels. An estimate
      holds the process-wide PDFium lock to its end otherwise, stalling every
      render behind it; with nothing running the cancel is a no-op. */
  const stopEstimates = () => {
    void invoke<boolean>("cancel_pdf_compression", {
      documentId: document.id,
    }).catch(() => {})
  }

  // A closing dialog must not strand its last estimate on that lock either.
  useEffect(
    () => () => {
      if (!exportingRef.current) stopEstimates()
    },
    [document.id],
  )

  useEffect(() => {
    if (busy) {
      return
    }

    const run = ++estimateRun.current
    setEstimating(true)
    setEstimateFailed(false)
    const timer = setTimeout(async () => {
      // The run this one replaces would otherwise hold the lock to its end.
      stopEstimates()
      try {
        const next = await invoke<CompressionEstimate | null>(
          "estimate_pdf_compression",
          { documentId: document.id, options },
        )
        if (estimateRun.current === run && next !== null) {
          setEstimate(next)
        }
      } catch {
        if (estimateRun.current === run) {
          setEstimateFailed(true)
        }
      } finally {
        if (estimateRun.current === run) {
          setEstimating(false)
        }
      }
    }, ESTIMATE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [busy, document.id, mode, dpi, quality])

  const cancel = async () => {
    if (await invoke<boolean>("cancel_pdf_compression", { documentId: document.id }).catch(() => false)) {
      stopRequested.current = false
    }
  }

  const start = async () => {
    exportingRef.current = true
    setBusy(true)
    setFailed(false)
    setProgress(null)
    stopRequested.current = false
    // The export must not queue behind an estimate for levels just left.
    stopEstimates()
    const outcome = await onExport({
      options,
      filterLabel: t("compressExport.filter"),
      suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${t("compressExport.suffix")}.pdf`,
    }, (next) => {
      setProgress(next)
      if (stopRequested.current) void cancel()
    })
    setBusy(false)
    setStopping(false)
    exportingRef.current = false
    if (outcome === "failed") setFailed(true)
    else onClose()
  }

  const savedPercent = estimate
    ? Math.round((1 - estimate.estimatedBytes / Math.max(estimate.originalBytes, 1)) * 100)
    : 0

  // A failed re-estimate must not pass the previous levels' figures off as
  // the newly selected one's.
  const estimateLine = estimateFailed
    ? t("compressExport.estimateFailed")
    : !estimate || estimating
      ? t("compressExport.estimating")
      : t(savedPercent > 0 ? "compressExport.estimate" : "compressExport.estimateNoSaving", {
          size: `${estimate.exact ? "" : "≈"}${formatBytes(estimate.estimatedBytes)}`,
          original: formatBytes(estimate.originalBytes),
          percent: savedPercent,
        })

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        data-testid="compress-dialog"
        showCloseButton={!busy}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>{t("compressExport.title")}</DialogTitle>
          <DialogDescription>{t("compressExport.description")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          aria-label={t("compressExport.mode")}
          disabled={busy}
          value={mode}
          onValueChange={(value) => setMode(value as CompressMode)}
          className="gap-4 py-2"
        >
          <Label className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
            <RadioGroupItem value="lossless" data-testid="compress-mode-lossless" />
            <span className="grid gap-1.5">
              <span>{t("compressExport.lossless")}</span>
              <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                {t("compressExport.losslessHint")}
              </span>
            </span>
          </Label>
          <Label className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
            <RadioGroupItem value="rasterized" data-testid="compress-mode-rasterized" />
            <span className="grid gap-1.5">
              <span>{t("compressExport.rasterized")}</span>
              <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                {t("compressExport.rasterizedHint")}
              </span>
            </span>
          </Label>
        </RadioGroup>
        {mode === "rasterized" ? (
          <div className="grid gap-4 pl-7">
            <div className="grid gap-2">
              <span className="text-sm font-medium">{t("compressExport.dpi")}</span>
              <RadioGroup
                aria-label={t("compressExport.dpi")}
                disabled={busy}
                value={String(dpi)}
                onValueChange={(value) => setDpi(Number(value))}
                className="gap-3"
              >
                {RASTER_DPI_CHOICES.map((choice) => (
                  <Label key={choice} className="gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
                    <RadioGroupItem
                      value={String(choice)}
                      data-testid={`compress-dpi-${choice}`}
                    />
                    <span>{choice} dpi</span>
                  </Label>
                ))}
              </RadioGroup>
            </div>
            <SliderRow
              disabled={busy}
              label={t("compressExport.quality")}
              display={`${quality}%`}
              min={MIN_JPEG_QUALITY}
              max={MAX_JPEG_QUALITY}
              step={5}
              value={quality}
              onChange={setQuality}
            />
          </div>
        ) : null}
        <p
          data-testid="compress-estimate"
          className="text-xs leading-relaxed tabular-nums text-muted-foreground"
        >
          {estimateLine}
        </p>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("compressExport.failed")}
          </p>
        ) : null}
        {busy ? (
          <OperationProgress
            label={t("compressExport.preparing")}
            progress={progress}
            testId="compress-progress"
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
            data-testid="compress-cancel"
          >
            {t(stopping ? "compressExport.stopping" : "compressExport.cancel")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void start()}
            data-testid="compress-start"
          >
            {t("compressExport.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
