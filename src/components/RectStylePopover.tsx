import { Info } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { SliderRow } from "@/components/SliderRow"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { RectStyle } from "@/lib/annotations"
import {
  isRectEffectKind,
  RECT_MAX_EFFECT_STRENGTH,
  RECT_MIN_EFFECT_STRENGTH,
  RECT_MIN_OPACITY,
  rectEffectKinds,
  rectSwatches,
} from "@/lib/annotationStyles"

const effectLabelKey = {
  translucent: "annotate.effectTranslucent",
  blur: "annotate.effectBlur",
  mosaic: "annotate.effectMosaic",
} as const

const amountLabelKey = {
  translucent: "annotate.opacity",
  blur: "annotate.blurStrength",
  mosaic: "annotate.mosaicSize",
} as const

type RectStylePopoverProps = {
  onChange: (style: RectStyle) => void
  style: RectStyle
}

export function RectStylePopover({ onChange, style }: RectStylePopoverProps) {
  const { t } = useTranslation()
  // A blur and a mosaic are built from the pixels under the box, so colour has
  // nothing to tint and the panel drops it.
  const usesColor = style.effect === "translucent"

  return (
    <div className="flex w-64 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium" id="rect-effect-label">
            {t("annotate.effect")}
          </p>
          {usesColor ? null : (
            <Popover>
              <ToolbarTooltip label={t("annotate.effectAbout")} side="top">
                <PopoverTrigger
                  render={
                    <Button
                      aria-label={t("annotate.effectAbout")}
                      size="icon-xs"
                      variant="ghost"
                    />
                  }
                >
                  <Info />
                </PopoverTrigger>
              </ToolbarTooltip>
              <PopoverContent align="end" className="w-64">
                <p
                  className="text-xs leading-relaxed text-muted-foreground"
                  data-slot="rect-effect-disclosure"
                >
                  {t("annotate.effectDisclosure")}
                </p>
              </PopoverContent>
            </Popover>
          )}
        </div>
        <ToggleGroup
          aria-labelledby="rect-effect-label"
          className="w-full"
          onValueChange={([next]) => {
            // Base UI permits an empty group when its active item is pressed,
            // but every rectangle always has exactly one effect.
            if (isRectEffectKind(next)) {
              onChange({ ...style, effect: next })
            }
          }}
          spacing={0}
          value={[style.effect]}
          variant="outline"
        >
          {rectEffectKinds.map((kind) => (
            <ToggleGroupItem
              aria-label={t(effectLabelKey[kind])}
              className="flex-1 text-xs"
              key={kind}
              value={kind}
            >
              {t(effectLabelKey[kind])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {usesColor ? (
        <div className="flex flex-col gap-1.5" data-slot="rect-colors">
          <p className="text-xs font-medium" id="rect-color-label">
            {t("annotate.rectColor")}
          </p>
          <ColorSwatchPicker
            allowCustom={false}
            labelledBy="rect-color-label"
            onChange={(color) => onChange({ ...style, color })}
            swatches={rectSwatches}
            value={style.color}
          />
        </div>
      ) : null}

      <div data-slot="rect-amount">
        {usesColor ? (
          <SliderRow
            display={`${Math.round(style.opacity * 100)}%`}
            label={t(amountLabelKey.translucent)}
            max={100}
            min={RECT_MIN_OPACITY * 100}
            onChange={(value) => onChange({ ...style, opacity: value / 100 })}
            step={5}
            value={Math.round(style.opacity * 100)}
          />
        ) : (
          <SliderRow
            display={t("annotate.effectStrengthValue", {
              strength: style.strength,
            })}
            label={t(amountLabelKey[style.effect])}
            max={RECT_MAX_EFFECT_STRENGTH}
            min={RECT_MIN_EFFECT_STRENGTH}
            onChange={(strength) => onChange({ ...style, strength })}
            step={1}
            value={style.strength}
          />
        )}
      </div>
    </div>
  )
}
