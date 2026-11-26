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
import type { useAnnotations } from "@/hooks/useAnnotations"
import { useExportDialogRun } from "@/hooks/useExportDialogRun"
import { noticeCatalogue } from "@/lib/notices"
import { exportFailureNotice, type A4Fitted, type PdfDocumentInfo } from "@/lib/pdf"

type A4ExportDialogProps = {
  document: PdfDocumentInfo
  /** Its tab is not the one showing: out of sight, with its state kept. */
  hidden?: boolean
  onClose: () => void
  onFit: ReturnType<typeof useAnnotations>["fitA4"]
  /** The unsaved in-memory A4 copy, which opens in a new tab beside this one. */
  onFitted: (fitted: A4Fitted) => void
}

/**
 * Fit to A4: every page fitted onto an A4 sheet in a new unsaved tab for the
 * reader to review and save manually. Says before it starts what a sheet
 * cannot carry over.
 */
export function A4ExportDialog({
  document,
  hidden = false,
  onClose,
  onFit,
  onFitted,
}: A4ExportDialogProps) {
  const { t } = useTranslation()
  const [failure, setFailure] = useState<ReturnType<typeof exportFailureNotice> | null>(null)
  const { busy, progress, requestStop, run, stopping } = useExportDialogRun(
    document.id,
    "cancel_pdf_operation",
  )

  const start = async () => {
    const result = await run((onProgress) => {
      setFailure(null)
      return onFit(onProgress)
    })

    if (!result.ran) {
      return
    }

    if (result.outcome && "failed" in result.outcome) {
      setFailure(exportFailureNotice(result.outcome.failed))
    } else if (result.outcome) {
      onFitted(result.outcome)
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
        {failure ? (
          <p className="text-sm text-destructive" role="alert">
            {failure === "exportFailed"
              ? t("a4Export.failed")
              : t(noticeCatalogue[failure].textKey)}
          </p>
        ) : null}
        {busy ? (
          // Every page counted, the file is still being put together: a bar
          // held full would read as stuck.
          progress && progress.completed >= progress.total ? (
            <OperationProgress
              label={t("a4Export.finishing")}
              progress={null}
              testId="a4-progress"
            />
          ) : (
            <OperationProgress
              label={t("a4Export.preparing")}
              progress={progress}
              testId="a4-progress"
            />
          )
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

              requestStop()
            }}
            variant="outline"
          >
            {t(stopping ? "a4Export.stopping" : busy ? "a4Export.stop" : "a4Export.cancel")}
          </Button>
          <Button data-testid="a4-start" disabled={busy} onClick={() => void start()}>
            {t("a4Export.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
