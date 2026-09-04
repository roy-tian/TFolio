import { Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { OperationProgress } from "@/components/OperationProgress"
import { PageNumbersSettings } from "@/components/PageNumbersSettings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  PageNumbersDraft,
  PageNumbersValidationError,
} from "@/lib/pageNumbers"
import type { PdfProgress } from "@/lib/progress"

type PageNumbersDialogProps = {
  draft: PageNumbersDraft
  hasPageNumbers: boolean
  isApplying: boolean
  isStopping: boolean
  onApply: () => void
  onDraftChange: (draft: PageNumbersDraft) => void
  onOpenChange: (open: boolean) => void
  onRemove: () => void
  onStop: () => void
  open: boolean
  pageCount: number
  progress: PdfProgress | null
  validationError: PageNumbersValidationError | null
}

export function PageNumbersDialog({
  draft,
  hasPageNumbers,
  isApplying,
  isStopping,
  onApply,
  onDraftChange,
  onOpenChange,
  onRemove,
  onStop,
  open,
  pageCount,
  progress,
  validationError,
}: PageNumbersDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-busy={isApplying}
        className="flex max-h-[calc(100svh-2rem)] w-[44rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]"
        data-testid="page-numbers-dialog"
        showCloseButton={!isApplying}
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("pageNumbers.title")}</DialogTitle>
          <DialogDescription>{t("pageNumbers.description")}</DialogDescription>
        </DialogHeader>

        {isApplying && progress ? (
          <div className="flex min-h-80 flex-1 flex-col items-center justify-center gap-3 p-8">
            <OperationProgress
              className="max-w-sm"
              label={t("pageNumbers.updating")}
              progress={progress}
              testId="page-numbers-progress"
            />
            <p className="text-center text-xs text-muted-foreground">
              {t("pageNumbers.progressHint")}
            </p>
            {/* The one control that reaches work already running: everything
                else the reader could press waits on the same document. */}
            <Button
              data-testid="page-numbers-stop"
              disabled={isStopping}
              onClick={onStop}
              type="button"
              variant="outline"
            >
              {isStopping ? t("pageNumbers.stopping") : t("pageNumbers.stop")}
            </Button>
          </div>
        ) : (
          /* The body scrolls as a whole, so the columns keep their natural
              heights and short content never earns a scrollbar. */
          <PageNumbersSettings
            className="min-h-0 flex-1 overflow-y-auto p-5"
            draft={draft}
            onDraftChange={onDraftChange}
            pageCount={pageCount}
            validationError={validationError}
          />
        )}

        <DialogFooter className="mx-0 mb-0 rounded-none border-t px-5 py-4">
          {hasPageNumbers ? (
            <Button
              disabled={isApplying}
              onClick={onRemove}
              type="button"
              variant="destructive"
            >
              <Trash2 data-icon="inline-start" />
              {t("pageNumbers.remove")}
            </Button>
          ) : null}
          <div className="flex flex-1 justify-end gap-2">
            <DialogClose render={<Button disabled={isApplying} variant="outline" />}>
              {t("pageNumbers.cancel")}
            </DialogClose>
            <Button
              data-testid="page-numbers-apply"
              disabled={isApplying || validationError !== null}
              onClick={onApply}
              type="button"
            >
              {hasPageNumbers ? t("pageNumbers.replace") : t("pageNumbers.apply")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
