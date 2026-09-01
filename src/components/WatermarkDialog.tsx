import { Info, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { SliderRow } from "@/components/SliderRow"
import { WatermarkPreview } from "@/components/WatermarkPreview"
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
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { WatermarkValidationError } from "@/lib/watermark"
import {
  clampWatermarkText,
  isWatermarkDirection,
  isWatermarkLayout,
  WATERMARK_MAX_WIDTH_RATIO,
  WATERMARK_MIN_WIDTH_RATIO,
  type WatermarkConfig,
} from "@/lib/watermark"

const validationLabelKey: Record<
  WatermarkValidationError,
  | "watermark.errorEmpty"
  | "watermark.errorMultiline"
  | "watermark.errorTooLong"
  | "watermark.errorStyle"
> = {
  empty: "watermark.errorEmpty",
  multiline: "watermark.errorMultiline",
  style: "watermark.errorStyle",
  tooLong: "watermark.errorTooLong",
}

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
  const textError =
    validationError && validationError !== "style"
      ? t(validationLabelKey[validationError])
      : null

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
            heights and short content never earns a scrollbar; from `sm` the
            sheet sticks so it stays in view while the controls pass it. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 sm:flex-row">
          <Field className="sm:sticky sm:top-0 sm:w-[14rem] sm:shrink-0 sm:self-start">
            <div className="flex items-center gap-0.5">
              <FieldLabel>{t("watermark.preview")}</FieldLabel>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      aria-label={t("watermark.disclosureAbout")}
                      size="icon-xs"
                      title={t("watermark.disclosureAbout")}
                      variant="ghost"
                    />
                  }
                >
                  <Info />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64">
                  <p
                    className="text-xs leading-relaxed text-muted-foreground"
                    data-slot="watermark-disclosure"
                  >
                    {t("watermark.disclosure")}
                  </p>
                </PopoverContent>
              </Popover>
            </div>
            <WatermarkPreview
              config={draft}
              placeholder={t("watermark.previewPlaceholder")}
            />
          </Field>

          <div className="min-w-0 flex-1">
            <FieldGroup>
              <Field data-invalid={Boolean(textError)}>
                <FieldLabel htmlFor="watermark-text">
                  {t("watermark.text")}
                </FieldLabel>
                <Input
                  aria-invalid={Boolean(textError)}
                  autoFocus
                  data-testid="watermark-text"
                  id="watermark-text"
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      text: clampWatermarkText(event.target.value),
                    })
                  }
                  placeholder={t("watermark.textPlaceholder")}
                  value={draft.text}
                />
                <FieldError>{textError}</FieldError>
              </Field>

              <Field data-testid="watermark-size">
                <SliderRow
                  display={t("watermark.percentValue", {
                    value: Math.round(draft.widthRatio * 100),
                  })}
                  label={t("watermark.size")}
                  max={WATERMARK_MAX_WIDTH_RATIO}
                  min={WATERMARK_MIN_WIDTH_RATIO}
                  onChange={(widthRatio) => onDraftChange({ ...draft, widthRatio })}
                  step={0.05}
                  value={draft.widthRatio}
                />
                <p className="text-xs text-muted-foreground">
                  {t("watermark.sizeHint")}
                </p>
              </Field>

              <Field>
                <FieldLabel id="watermark-direction-label">
                  {t("watermark.direction")}
                </FieldLabel>
                <ToggleGroup
                  aria-labelledby="watermark-direction-label"
                  onValueChange={([value]) => {
                    if (isWatermarkDirection(value)) {
                      onDraftChange({ ...draft, direction: value })
                    }
                  }}
                  spacing={0}
                  value={[draft.direction]}
                  variant="outline"
                >
                  <ToggleGroupItem value="ascending">
                    {t("watermark.directionAscending")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="descending">
                    {t("watermark.directionDescending")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <Field>
                <FieldLabel id="watermark-layout-label">
                  {t("watermark.layout")}
                </FieldLabel>
                <ToggleGroup
                  aria-labelledby="watermark-layout-label"
                  onValueChange={([value]) => {
                    if (isWatermarkLayout(value)) {
                      onDraftChange({ ...draft, layout: value })
                    }
                  }}
                  spacing={0}
                  value={[draft.layout]}
                  variant="outline"
                >
                  <ToggleGroupItem value="single">
                    {t("watermark.layoutSingle")}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="zebra">
                    {t("watermark.layoutZebra")}
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>

              {validationError === "style" ? (
                <FieldError>{t("watermark.errorStyle")}</FieldError>
              ) : null}
            </FieldGroup>
          </div>
        </div>

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
