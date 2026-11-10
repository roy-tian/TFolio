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
import type { useAnnotations } from "@/hooks/useAnnotations"
import type { PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

type A4ExportDialogProps = {
  document: PdfDocumentInfo
  /** Its tab is not the one showing: out of sight, with its state kept. */
  hidden?: boolean
  /** Unsaved work the copy cannot carry keeps the tab; the copy opens beside it. */
  keepsOriginal: boolean
  onClose: () => void
  onExport: ReturnType<typeof useAnnotations>["exportA4"]
  /** The written copy, which the tab shows from now on. */
  onSaved: (document: PdfDocumentInfo) => void
  suggestedName: string
}

/**
 * Save as A4: every page fitted onto an A4 sheet in a new file, which the tab
 * then shows. Says before it starts what a sheet cannot carry over.
 */
export function A4ExportDialog({
  document,
  hidden = false,
  keepsOriginal,
  onClose,
  onExport,
  onSaved,
  suggestedName,
}: A4ExportDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  // Asked again with every report until the engine is there to hear it.
  const stopRequested = useRef(false)

  const stop = async () => {
    if (
      await invoke<boolean>("cancel_pdf_operation", { documentId: document.id }).catch(
        () => false,
      )
    ) {
      stopRequested.current = false
    }
  }

  const start = async () => {
    setBusy(true)
    setFailed(false)
    setProgress(null)
    stopRequested.current = false

    const outcome = await onExport(
      {
        filterLabel: t("annotate.exportFilter"),
        suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${t("a4Export.suffix")}.pdf`,
      },
      (next) => {
        setProgress(next)

        if (stopRequested.current) {
          void stop()
        }
      },
    )

    setBusy(false)
    setStopping(false)

    if (outcome === "failed") {
      setFailed(true)
    } else if (outcome) {
      onSaved(outcome)
    } else {
      onClose()
    }
  }

  return (
    <Dialog
      open={!hidden}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent aria-busy={busy} data-testid="a4-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("a4Export.title")}</DialogTitle>
          <DialogDescription>{t("a4Export.description")}</DialogDescription>
        </DialogHeader>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("a4Export.leftBehind")}</p>
        {keepsOriginal ? (
          <p className="text-xs leading-relaxed text-muted-foreground" data-testid="a4-keeps-original">
            {t("a4Export.keepsOriginal")}
          </p>
        ) : null}
        {failed ? (
          <p className="text-sm text-destructive" role="alert">
            {t("a4Export.failed")}
          </p>
        ) : null}
        {busy ? (
          <OperationProgress
            label={t("a4Export.preparing")}
            progress={progress}
            testId="a4-progress"
          />
        ) : null}
        <DialogFooter>
          <Button
            data-testid="a4-cancel"
            disabled={stopping}
            onClick={() => {
              if (!busy) {
                onClose()
                return
              }

              stopRequested.current = true
              setStopping(true)
              void stop()
            }}
            variant="outline"
          >
            {t(stopping ? "a4Export.stopping" : busy ? "a4Export.stop" : "a4Export.cancel")}
          </Button>
          <Button data-testid="a4-save" disabled={busy} onClick={() => void start()}>
            {t("a4Export.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
