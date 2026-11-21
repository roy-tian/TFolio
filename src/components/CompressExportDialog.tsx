import { useEffect, useId, useRef, useState } from "react"
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
import { Slider } from "@/components/ui/slider"
import type { useAnnotations } from "@/hooks/useAnnotations"
import {
  DEFAULT_IMAGE_QUALITY,
  IMAGE_QUALITY_STEP,
  MAX_IMAGE_QUALITY,
  MIN_IMAGE_QUALITY,
  type CompressionEstimate,
  type CompressionOptions,
} from "@/lib/compressExport"
import { formatBytes } from "@/lib/formatBytes"
import type { PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

/** Long enough for a run of arrow keys to settle, short enough to feel live. */
const ESTIMATE_DEBOUNCE_MS = 250

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
  const { i18n, t } = useTranslation()
  const sliderLabelId = useId()
  // `imageQuality` follows every drag step immediately; `committedQuality`
  // updates on release (and on each arrow press) so dragging never stalls the
  // backend with throwaway estimates.
  const [imageQuality, setImageQuality] = useState(DEFAULT_IMAGE_QUALITY)
  const [committedQuality, setCommittedQuality] = useState(DEFAULT_IMAGE_QUALITY)
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
  // Answers already had, by quality percentage: the dialog is modal, so the
  // document they measured cannot change while it is open.
  const estimates = useRef(new Map<number, CompressionEstimate>())
  // Every estimate and export still in flight. A run that reaches the engine
  // after the release would rebuild its cache with nothing left to free it.
  const inflight = useRef<Promise<unknown>>(Promise.resolve())
  const track = <T,>(pending: Promise<T>) => {
    inflight.current = Promise.allSettled([inflight.current, pending])
    return pending
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
    const known = estimates.current.get(committedQuality)
    if (known) {
      stopEstimates()
      setEstimate(known)
      setEstimating(false)
      return
    }

    setEstimating(true)
    const options: CompressionOptions = { imageQuality: committedQuality }
    const timer = setTimeout(async () => {
      // The run this one replaces would otherwise hold the lock to its end.
      stopEstimates()
      try {
        const next = await track(invoke<CompressionEstimate | null>(
          "estimate_pdf_compression",
          { documentId: document.id, options },
        ))
        if (next !== null) {
          estimates.current.set(committedQuality, next)
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
  }, [busy, document.id, committedQuality])

  const cancel = async () => {
    if (await invoke<boolean>("cancel_pdf_compression", { documentId: document.id }).catch(() => false)) {
      stopRequested.current = false
    }
  }

  const start = async () => {
    const options: CompressionOptions = { imageQuality }
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

  // While dragging over an already-cached stop, show that estimate right away;
  // over an uncached stop, wait until release instead of firing IPC per pixel.
  const dragging = imageQuality !== committedQuality
  const shownEstimate = dragging ? (estimates.current.get(imageQuality) ?? null) : estimate
  const waitingEstimate = dragging ? shownEstimate === null : (!estimate || estimating)
  const savedPercent = shownEstimate
    ? Math.round((1 - shownEstimate.estimatedBytes / Math.max(shownEstimate.originalBytes, 1)) * 100)
    : 0

  // A failed re-estimate must not pass the previous levels' figures off as
  // the newly selected one's.
  const estimateLine = !dragging && estimateFailed
    ? t("compressExport.estimateFailed")
    : waitingEstimate || !shownEstimate
      ? t("compressExport.estimating")
      : t(savedPercent > 0 ? "compressExport.estimate" : "compressExport.estimateNoSaving", {
          size: formatBytes(shownEstimate.estimatedBytes, i18n.language),
          percent: savedPercent,
        })

  const qualityDisplay = imageQuality === MAX_IMAGE_QUALITY
    ? t("compressExport.imageQualityOriginal")
    : t("compressExport.imageQualityValue", { percent: imageQuality })

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
        <div className="grid gap-2.5 py-2" data-testid="compress-quality">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="text-sm font-medium" id={sliderLabelId}>
              {t("compressExport.imageQuality")}
            </span>
            <span
              data-testid="compress-quality-value"
              className="text-sm tabular-nums text-muted-foreground"
            >
              {qualityDisplay}
            </span>
          </div>
          {/* Single-thumb array: a scalar falls back to a two-thumb range. */}
          <Slider
            aria-labelledby={sliderLabelId}
            disabled={busy}
            min={MIN_IMAGE_QUALITY}
            max={MAX_IMAGE_QUALITY}
            step={IMAGE_QUALITY_STEP}
            value={[imageQuality]}
            onValueChange={(next) => {
              const value = Array.isArray(next)
                ? (next[0] ?? MIN_IMAGE_QUALITY)
                : (next as number)
              setImageQuality(value)
            }}
            onValueCommitted={(next) => {
              const value = Array.isArray(next)
                ? (next[0] ?? MIN_IMAGE_QUALITY)
                : (next as number)
              setImageQuality(value)
              setCommittedQuality(value)
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
            <span>{t("compressExport.smallerSize")}</span>
            <span>{t("compressExport.keepOriginal")}</span>
          </div>
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
            {t(
              stopping
                ? "compressExport.stopping"
                : busy
                  ? "compressExport.stop"
                  : "compressExport.cancel",
            )}
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
