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
import { exportFailureNotice, type A4Saved, type PdfDocumentInfo } from "@/lib/pdf"

type A4ExportDialogProps = {
  document: PdfDocumentInfo
  /** Its tab is not the one showing: out of sight, with its state kept. */
  hidden?: boolean
  /** Unsaved work the copy cannot carry keeps the tab; the copy opens beside it. */
  keepsOriginal: boolean
  onClose: () => void
  onExport: ReturnType<typeof useAnnotations>["exportA4"]
  /** The written copy, which the tab shows from now on. */
  onSaved: (saved: A4Saved) => void
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
  // Beside the button that failed, not in a corner: the refusals a reader can
  // act on in their own words, as a Save As names them.
  const [failure, setFailure] = useState<ReturnType<typeof exportFailureNotice> | null>(null)
  const { busy, progress, requestStop, run, stopping } = useExportDialogRun(
    document.id,
    "cancel_pdf_operation",
  )

  const start = async () => {
    const result = await run((onProgress) => {
      setFailure(null)
      return onExport(
        {
          filterLabel: t("annotate.exportFilter"),
          suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${t("a4Export.suffix")}.pdf`,
        },
        onProgress,
      )
    })

    if (!result.ran || result.outcome === "busy") {
      return
    }

    if (result.outcome && "failed" in result.outcome) {
      setFailure(exportFailureNotice(result.outcome.failed))
    } else if (result.outcome) {
      onSaved(result.outcome)
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
        {failure ? (
          <p className="text-sm text-destructive" role="alert">
            {failure === "exportFailed"
              ? t("a4Export.failed")
              : t(noticeCatalogue[failure].textKey)}
          </p>
        ) : null}
        {busy ? (
          // Every page counted, the file is still being put together and
          // written: a bar held full would read as stuck.
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
          <Button data-testid="a4-save" disabled={busy} onClick={() => void start()}>
            {t("a4Export.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
