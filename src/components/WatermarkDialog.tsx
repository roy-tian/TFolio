import { Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { OperationProgress } from "@/components/OperationProgress"
import { WatermarkSettings } from "@/components/WatermarkSettings"
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
import type { PdfProgress } from "@/lib/progress"
import type {
  WatermarkConfig,
  WatermarkValidationError,
} from "@/lib/watermark"

type WatermarkDialogProps = {
  draft: WatermarkConfig
  hasWatermark: boolean
  isApplying: boolean
  isStopping: boolean
  onApply: () => void
  onDraftChange: (draft: WatermarkConfig) => void
  onOpenChange: (open: boolean) => void
  onRemove: () => void
  onStop: () => void
  open: boolean
  progress: PdfProgress | null
  validationError: WatermarkValidationError | null
}

export function WatermarkDialog({
  draft,
  hasWatermark,
  isApplying,
  isStopping,
  onApply,
  onDraftChange,
  onOpenChange,
  onRemove,
  onStop,
  open,
  progress,
  validationError,
}: WatermarkDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-busy={isApplying}
        className="flex max-h-[calc(100svh-2rem)] w-[44rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]"
        data-testid="watermark-dialog"
        showCloseButton={!isApplying}
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("watermark.title")}</DialogTitle>
          <DialogDescription>{t("watermark.description")}</DialogDescription>
        </DialogHeader>

        {isApplying && progress ? (
          <div className="flex min-h-80 flex-1 flex-col items-center justify-center gap-3 p-8">
            <OperationProgress
              className="max-w-sm"
              label={t("watermark.updating")}
              progress={progress}
              testId="watermark-progress"
            />
            <p className="text-center text-xs text-muted-foreground">
              {t("watermark.progressHint")}
            </p>
            {/* The one control that reaches work already running — see the
                page-number dialog, which stops its own the same way. */}
            <Button
              data-testid="watermark-stop"
              disabled={isStopping}
              onClick={onStop}
              type="button"
              variant="outline"
            >
              {isStopping ? t("watermark.stopping") : t("watermark.stop")}
            </Button>
          </div>
        ) : (
          /* The body scrolls as a whole, so the columns keep their natural
              heights and short content never earns a scrollbar. */
          <WatermarkSettings
            autoFocus
            className="min-h-0 flex-1 overflow-y-auto p-5"
            draft={draft}
            onDraftChange={onDraftChange}
            validationError={validationError}
          />
        )}

        <DialogFooter className="mx-0 mb-0 rounded-none px-5 py-4">
          {hasWatermark ? (
            <Button
              disabled={isApplying}
              onClick={onRemove}
              type="button"
              variant="destructive"
            >
              <Trash2 data-icon="inline-start" />
              {t("watermark.remove")}
            </Button>
          ) : null}
          <div className="flex flex-1 justify-end gap-2">
            <DialogClose render={<Button disabled={isApplying} variant="outline" />}>
              {t("watermark.cancel")}
            </DialogClose>
            <Button
              data-testid="watermark-apply"
              disabled={isApplying || validationError !== null}
              onClick={onApply}
              type="button"
            >
              {hasWatermark ? t("watermark.replace") : t("watermark.apply")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
