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
import type { PdfDocumentInfo } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

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
  const hasBookmarks = document.outline.some((item) =>
    item.pageNumber !== null && item.pageNumber >= 1 && item.pageNumber <= document.numPages,
  )
  const [mode, setMode] = useState<SplitMode>(hasBookmarks ? "bookmarks" : "pages")
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const stopRequested = useRef(false)

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
      options: mode === "bookmarks" ? { format: "bookmarks" } : { format: "pages" },
      filterLabel: t("splitExport.filter"),
      suggestedName: `${suggestedName.replace(/\.pdf$/i, "")}-${t("splitExport.suffix")}.zip`,
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
        {mode === "bookmarks" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("splitExport.bookmarksSizeHint")}
          </p>
        ) : null}
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
              stopRequested.current = true
              setStopping(true)
              void cancel()
            }}
            data-testid="split-export-cancel"
          >
            {t(stopping ? "splitExport.stopping" : "splitExport.cancel")}
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
