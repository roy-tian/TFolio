import { useTranslation } from "react-i18next"

import { OperationProgress } from "@/components/OperationProgress"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { PdfProgress } from "@/lib/progress"

type PrintDialogProps = {
  onStop: () => void
  open: boolean
  progress: PdfProgress
}

/** What the reader watches while the pages are drawn for paper. It closes
    itself the moment the OS dialog — the one that actually prints — opens. */
export function PrintDialog({ onStop, open, progress }: PrintDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onStop()
        }
      }}
      open={open}
    >
      <DialogContent
        aria-busy
        className="w-96 gap-0 p-0 sm:max-w-96"
        data-testid="print-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("print.title")}</DialogTitle>
          <DialogDescription>{t("print.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 p-8">
          <OperationProgress
            label={t("print.preparing")}
            progress={progress}
            testId="print-progress"
          />
          <p className="text-center text-xs text-muted-foreground">
            {t("print.progressHint")}
          </p>
          <Button
            data-testid="print-stop"
            onClick={onStop}
            type="button"
            variant="outline"
          >
            {t("print.stop")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
