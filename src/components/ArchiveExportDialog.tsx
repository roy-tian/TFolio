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
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { useAnnotations } from "@/hooks/useAnnotations"
import type { ArchiveFormat } from "@/lib/archiveExport"
import type { PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

type ArchiveExportDialogProps = {
  document: PdfDocumentInfo
  suggestedName: string
  onExport: ReturnType<typeof useAnnotations>["exportArchive"]
  onClose: () => void
}

export function ArchiveExportDialog({
  document,
  suggestedName,
  onExport,
  onClose,
}: ArchiveExportDialogProps) {
  const { t } = useTranslation()
  const [format, setFormat] = useState<ArchiveFormat>("jpg")
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const stopRequested = useRef(false)
  const hasBookmarks = document.outline.some((item) =>
    item.pageNumber !== null && item.pageNumber >= 1 && item.pageNumber <= document.numPages,
  )

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
    const outcome = await onExport({
      format,
      filterLabel: t("archiveExport.filter"),
      suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${format}.zip`,
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
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        data-testid="archive-export-dialog"
        showCloseButton={!busy}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle>{t("archiveExport.title")}</DialogTitle>
          <DialogDescription>{t("archiveExport.description")}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          aria-label={t("archiveExport.format")}
          disabled={busy}
          value={format}
          onValueChange={(value) => setFormat(value as ArchiveFormat)}
          className="gap-4 py-2"
        >
          {(["jpg", "png", "bookmarks"] as const).map((option) => (
            <Label key={option} className="items-start gap-3">
              <RadioGroupItem
                value={option}
                disabled={option === "bookmarks" && !hasBookmarks}
                data-testid={`archive-format-${option}`}
              />
              <span className="grid gap-1.5">
                <span>{t(`archiveExport.${option}`)}</span>
                <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                  {option === "bookmarks"
                    ? t(hasBookmarks ? "archiveExport.bookmarksHint" : "archiveExport.noBookmarks")
                    : t("archiveExport.imagesHint")}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
        {format === "bookmarks" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("archiveExport.bookmarksSizeHint")}
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t("archiveExport.failed")}
          </p>
        ) : null}
        {busy ? (
          <OperationProgress
            label={t("archiveExport.preparing")}
            progress={progress}
            testId="archive-export-progress"
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
            data-testid="archive-export-cancel"
          >
            {t(stopping ? "archiveExport.stopping" : "archiveExport.cancel")}
          </Button>
          <Button
            disabled={busy || (format === "bookmarks" && !hasBookmarks)}
            onClick={() => void start()}
            data-testid="archive-export-start"
          >
            {t("archiveExport.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
