import { Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

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
import type {
  WatermarkConfig,
  WatermarkValidationError,
} from "@/lib/watermark"

type WatermarkDialogProps = {
  draft: WatermarkConfig
  hasWatermark: boolean
  isApplying: boolean
  onApply: () => void
  onDraftChange: (draft: WatermarkConfig) => void
  onOpenChange: (open: boolean) => void
  onRemove: () => void
  open: boolean
  validationError: WatermarkValidationError | null
}

export function WatermarkDialog({
  draft,
  hasWatermark,
  isApplying,
  onApply,
  onDraftChange,
  onOpenChange,
  onRemove,
  open,
  validationError,
}: WatermarkDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[calc(100svh-2rem)] w-[40rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[40rem]"
        data-testid="watermark-dialog"
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("watermark.title")}</DialogTitle>
          <DialogDescription>{t("watermark.description")}</DialogDescription>
        </DialogHeader>

        {/* The body scrolls as a whole, so the columns keep their natural
            heights and short content never earns a scrollbar. */}
        <WatermarkSettings
          autoFocus
          className="min-h-0 flex-1 overflow-y-auto p-5"
          draft={draft}
          onDraftChange={onDraftChange}
          validationError={validationError}
        />

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
