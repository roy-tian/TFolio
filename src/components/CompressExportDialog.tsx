import { useEffect, useRef, useState } from "react"
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
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { useAnnotations } from "@/hooks/useAnnotations"
import {
  DEFAULT_IMAGE_QUALITY,
  IMAGE_QUALITY_LEVELS,
  type CompressionEstimate,
  type CompressionOptions,
  type ImageQualityLevel,
} from "@/lib/compressExport"
import { formatBytes } from "@/lib/formatBytes"
import type { PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

/** Long enough for a run of arrow keys to settle, short enough to feel live. */
const ESTIMATE_DEBOUNCE_MS = 300

type CompressExportDialogProps = {
  document: PdfDocumentInfo
  /** Its tab is not the one showing: out of sight, with its state kept. */
  hidden?: boolean
  suggestedName: string
  onExport: ReturnType<typeof useAnnotations>["exportCompressed"]
  onClose: () => void
}

export function CompressExportDialog({
  document,
  hidden = false,
  suggestedName,
  onExport,
  onClose,
}: CompressExportDialogProps) {
  const { t } = useTranslation()
  const [imageQuality, setImageQuality] = useState<ImageQualityLevel>(DEFAULT_IMAGE_QUALITY)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const [estimate, setEstimate] = useState<CompressionEstimate | null>(null)
  const [estimating, setEstimating] = useState(true)
  const [estimateFailed, setEstimateFailed] = useState(false)
  const stopRequested = useRef(false)
  // Only the newest estimate may answer: a slower run for abandoned levels
  // must not overwrite the one the reader is looking at.
  const estimateRun = useRef(0)
  // Answers already had, by level: the dialog is modal, so the document they
  // measured cannot change while it is open.
  const estimates = useRef(new Map<ImageQualityLevel, CompressionEstimate>())
  // Every estimate and export still in flight. A run that reaches the engine
  // after the release would rebuild its cache with nothing left to free it.
  const inflight = useRef<Promise<unknown>>(Promise.resolve())
  const track = <T,>(pending: Promise<T>) => {
    inflight.current = Promise.allSettled([inflight.current, pending])
    return pending
  }

  const options: CompressionOptions = {
    imageDpi:
      IMAGE_QUALITY_LEVELS.find(({ level }) => level === imageQuality)?.imageDpi ?? null,
  }

  /** Stops any estimate still running for superseded levels. An estimate
      holds the process-wide PDFium lock to its end otherwise, stalling every
      render behind it; with nothing running the cancel is a no-op. */
  const stopEstimates = () => {
    void invoke<boolean>("cancel_pdf_compression_estimate", {
      documentId: document.id,
    }).catch(() => {})
  }

  // A closing dialog must not strand its last estimate on that lock either,
  // nor leave the engine holding copies of the document for it. An export
  // outlives it: its cancel target is not the estimates'.
  useEffect(
    () => () => {
      stopEstimates()
      void inflight.current.then(() =>
        invoke("release_pdf_compression", { documentId: document.id }),
      ).catch(() => {})
    },
    [document.id],
  )

  useEffect(() => {
    if (busy) {
      return
    }

    const run = ++estimateRun.current
    setEstimateFailed(false)
    const known = estimates.current.get(imageQuality)
    if (known) {
      stopEstimates()
      setEstimate(known)
      setEstimating(false)
      return
    }

    setEstimating(true)
    const timer = setTimeout(async () => {
      // The run this one replaces would otherwise hold the lock to its end.
      stopEstimates()
      try {
        const next = await track(invoke<CompressionEstimate | null>(
          "estimate_pdf_compression",
          { documentId: document.id, options },
        ))
        if (next !== null) {
          estimates.current.set(imageQuality, next)
        }
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
  }, [busy, document.id, imageQuality])

  const cancel = async () => {
    if (await invoke<boolean>("cancel_pdf_compression", { documentId: document.id }).catch(() => false)) {
      stopRequested.current = false
    }
  }

  const start = async () => {
    setBusy(true)
    setFailed(false)
    setProgress(null)
    stopRequested.current = false
    // The export must not queue behind an estimate for levels just left.
    stopEstimates()
    const outcome = await track(onExport({
      options,
      filterLabel: t("compressExport.filter"),
      suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${t("compressExport.suffix")}.pdf`,
    }, (next) => {
      setProgress(next)
      if (stopRequested.current) void cancel()
    }))
    setBusy(false)
    setStopping(false)
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
          size: formatBytes(estimate.estimatedBytes),
          percent: savedPercent,
        })

  return (
    <Dialog
      open={!hidden}
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
        <div className="grid gap-2 py-2">
          <span className="text-sm font-medium">{t("compressExport.imageQuality")}</span>
          <RadioGroup
            aria-label={t("compressExport.imageQuality")}
            disabled={busy}
            value={imageQuality}
            onValueChange={(value) => setImageQuality(value as ImageQualityLevel)}
            className="gap-3"
          >
            {IMAGE_QUALITY_LEVELS.map(({ level }) => (
              <Label
                key={level}
                className="gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50"
              >
                <RadioGroupItem value={level} data-testid={`compress-image-${level}`} />
                <span>{t(`compressExport.imageLevels.${level}`)}</span>
              </Label>
            ))}
          </RadioGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("compressExport.imageQualityHint")}
          </p>
        </div>
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
