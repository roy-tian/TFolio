import { Info } from "lucide-react"
import { useTranslation } from "react-i18next"

import { SliderRow } from "@/components/SliderRow"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { WatermarkPreview } from "@/components/WatermarkPreview"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  clampWatermarkText,
  defaultWatermarkWidthRatio,
  isWatermarkDirection,
  isWatermarkLayout,
  WATERMARK_MAX_WIDTH_RATIO,
  WATERMARK_MIN_WIDTH_RATIO,
  type WatermarkConfig,
  type WatermarkValidationError,
} from "@/lib/watermark"
import { cn } from "@/lib/utils"

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

type WatermarkSettingsProps = {
  /** Prefix for the field ids, so two of these can share a page. */
  idPrefix?: string
  autoFocus?: boolean
  className?: string
  draft: WatermarkConfig
  onDraftChange: (draft: WatermarkConfig) => void
  validationError: WatermarkValidationError | null
}

/** The watermark's own controls, shared by the applying dialog and the merge
    wizard's last step, so the two can never drift apart. */
export function WatermarkSettings({
  autoFocus = false,
  className,
  draft,
  idPrefix = "watermark",
  onDraftChange,
  validationError,
}: WatermarkSettingsProps) {
  const { t } = useTranslation()
  const textError =
    validationError && validationError !== "style"
      ? t(validationLabelKey[validationError])
      : null
  const textId = `${idPrefix}-text`
  const directionId = `${idPrefix}-direction-label`
  const layoutId = `${idPrefix}-layout-label`

  return (
    // From `sm` the sheet sticks, so it stays in view while the controls pass
    // it; natural heights keep short content from earning a scrollbar.
    <div className={cn("flex flex-col gap-5 sm:flex-row", className)}>
      <Field className="sm:sticky sm:top-0 sm:w-[14rem] sm:shrink-0 sm:self-start">
        <div className="flex items-center gap-0.5">
          <FieldLabel>{t("watermark.preview")}</FieldLabel>
          <Popover>
            <ToolbarTooltip label={t("watermark.disclosureAbout")} side="top">
              <PopoverTrigger
                render={
                  <Button
                    aria-label={t("watermark.disclosureAbout")}
                    size="icon-xs"
                    variant="ghost"
                  />
                }
              >
                <Info />
              </PopoverTrigger>
            </ToolbarTooltip>
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
            <FieldLabel htmlFor={textId}>{t("watermark.text")}</FieldLabel>
            <Input
              aria-invalid={Boolean(textError)}
              autoFocus={autoFocus}
              data-testid="watermark-text"
              id={textId}
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

          <div className="grid grid-cols-2 gap-4">
            <Field className="min-w-0">
              <FieldLabel id={directionId}>{t("watermark.direction")}</FieldLabel>
              <ToggleGroup
                className="w-full"
                aria-labelledby={directionId}
                onValueChange={([value]) => {
                  if (isWatermarkDirection(value)) {
                    onDraftChange({ ...draft, direction: value })
                  }
                }}
                spacing={0}
                value={[draft.direction]}
                variant="outline"
              >
                <ToggleGroupItem className="h-auto min-h-7 min-w-0 flex-1 whitespace-normal py-1 text-center" value="ascending">
                  {t("watermark.directionAscending")}
                </ToggleGroupItem>
                <ToggleGroupItem className="h-auto min-h-7 min-w-0 flex-1 whitespace-normal py-1 text-center" value="descending">
                  {t("watermark.directionDescending")}
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>

            <Field className="min-w-0">
              <FieldLabel id={layoutId}>{t("watermark.layout")}</FieldLabel>
              <ToggleGroup
                className="w-full"
                aria-labelledby={layoutId}
                onValueChange={([value]) => {
                  if (isWatermarkLayout(value)) {
                    onDraftChange({
                      ...draft,
                      layout: value,
                      widthRatio: defaultWatermarkWidthRatio(value),
                    })
                  }
                }}
                spacing={0}
                value={[draft.layout]}
                variant="outline"
              >
                <ToggleGroupItem className="h-auto min-h-7 min-w-0 flex-1 whitespace-normal py-1 text-center" value="single">
                  {t("watermark.layoutSingle")}
                </ToggleGroupItem>
                <ToggleGroupItem className="h-auto min-h-7 min-w-0 flex-1 whitespace-normal py-1 text-center" value="zebra">
                  {t("watermark.layoutZebra")}
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </div>

          <Card className="gap-2 p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={draft.rasterize}
                data-testid="watermark-rasterize"
                id={`${idPrefix}-rasterize`}
                onCheckedChange={(rasterize) => onDraftChange({ ...draft, rasterize })}
              />
              <FieldLabel htmlFor={`${idPrefix}-rasterize`}>
                {t("watermark.rasterize")}
              </FieldLabel>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("watermark.rasterizeHint")}
            </p>
          </Card>

          {validationError === "style" ? (
            <FieldError>{t("watermark.errorStyle")}</FieldError>
          ) : null}
        </FieldGroup>
      </div>
    </div>
  )
}
