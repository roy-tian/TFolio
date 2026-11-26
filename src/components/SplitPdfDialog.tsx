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
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { useAnnotations } from "@/hooks/useAnnotations"
import { useExportDialogRun } from "@/hooks/useExportDialogRun"
import type { PdfDocumentInfo } from "@/lib/pdf"

type SplitMode = "bookmarks" | "pages"

type SplitPdfDialogProps = {
  document: PdfDocumentInfo
  /** Its tab is not the one showing: out of sight, with its state kept. */
  hidden?: boolean
  suggestedName: string
  onExport: ReturnType<typeof useAnnotations>["exportArchive"]
  onClose: () => void
}

export function SplitPdfDialog({
  document,
  hidden = false,
  suggestedName,
  onExport,
  onClose,
}: SplitPdfDialogProps) {
  const { t } = useTranslation()
  const hasBookmarks = document.splitsByBookmarks
  const [mode, setMode] = useState<SplitMode>(hasBookmarks ? "bookmarks" : "pages")
  const [failed, setFailed] = useState(false)
  const { busy, progress, requestStop, run, stopping } = useExportDialogRun(
    document.id,
    "cancel_pdf_archive",
  )

  const start = async () => {
    const result = await run((onProgress) => {
      setFailed(false)
      return onExport(
        {
          options: mode === "bookmarks" ? { format: "bookmarks" } : { format: "pages" },
          filterLabel: t("splitExport.filter"),
          suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${t("splitExport.suffix")}.zip`,
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
        data-testid="split-dialog"
        showCloseButton={!busy}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>{t("splitExport.title")}</DialogTitle>
          <DialogDescription>{t("splitExport.description")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          aria-label={t("splitExport.mode")}
          disabled={busy}
          value={mode}
          onValueChange={(value) => setMode(value as SplitMode)}
          className="gap-4 py-2"
        >
          <Label className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
            <RadioGroupItem
              value="bookmarks"
              disabled={!hasBookmarks}
              data-testid="split-mode-bookmarks"
            />
            <span className="grid gap-1.5">
              <span>{t("splitExport.bookmarks")}</span>
              <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                {t(hasBookmarks ? "splitExport.bookmarksHint" : "splitExport.noBookmarks")}
              </span>
            </span>
          </Label>
          <Label className="items-start gap-3 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50">
            <RadioGroupItem value="pages" data-testid="split-mode-pages" />
            <span className="grid gap-1.5">
              <span>{t("splitExport.pages")}</span>
              <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                {t("splitExport.pagesHint")}
              </span>
            </span>
          </Label>
        </RadioGroup>
        <p
          data-testid="split-warning"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {t("splitExport.sizeHint")}
        </p>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("splitExport.failed")}
          </p>
        ) : null}
        {busy ? (
          <OperationProgress
            label={t("splitExport.preparing")}
            progress={progress}
            testId="split-export-progress"
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
            data-testid="split-export-cancel"
          >
            {t(
              stopping
                ? "splitExport.stopping"
                : busy
                  ? "splitExport.stop"
                  : "splitExport.cancel",
            )}
          </Button>
          <Button
            disabled={busy || (mode === "bookmarks" && !hasBookmarks)}
            onClick={() => void start()}
            data-testid="split-export-start"
          >
            {t("splitExport.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
