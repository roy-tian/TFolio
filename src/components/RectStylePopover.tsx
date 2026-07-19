import { Info } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { SliderRow } from "@/components/SliderRow"
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
  RECT_MAX_CORNER_RADIUS,
  RECT_MAX_EFFECT_STRENGTH,
  RECT_MAX_STROKE_WIDTH,
  RECT_MIN_EFFECT_STRENGTH,
  RECT_MIN_OPACITY,
  RECT_MIN_STROKE_WIDTH,
  rectEffectKinds,
  rectFillSwatches,
  rectStrokeSwatches,
} from "@/lib/annotationStyles"

const effectLabelKey = {
  none: "annotate.effectNone",
  mosaic: "annotate.effectMosaic",
  blur: "annotate.effectBlur",
} as const

type RectStylePopoverProps = {
  onChange: (style: RectStyle) => void
  style: RectStyle
}

/**
 * The rectangle tool's options panel: an optional image treatment, followed by
 * the vector appearance used when no treatment is selected.
 */
export function RectStylePopover({ onChange, style }: RectStylePopoverProps) {
  const { t } = useTranslation()
  const effectActive = style.effect.kind !== "none"

  return (
    <div className="flex w-64 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium" id="rect-effect-label">
            {t("annotate.effect")}
          </p>
          {effectActive ? (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    aria-label={t("annotate.effectAbout")}
                    size="icon-xs"
                    title={t("annotate.effectAbout")}
                    variant="ghost"
                  />
                }
              >
                <Info />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64">
                <p
                  className="text-xs leading-relaxed text-muted-foreground"
                  data-slot="rect-effect-disclosure"
                >
                  {t("annotate.effectDisclosure")}
                </p>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        <ToggleGroup
          aria-labelledby="rect-effect-label"
          className="w-full"
          onValueChange={([next]) => {
            // Base UI permits an empty group when its active item is pressed,
            // but every rectangle always has exactly one effect mode.
            if (isRectEffectKind(next)) {
              onChange({ ...style, effect: { ...style.effect, kind: next } })
            }
          }}
          spacing={0}
          value={[style.effect.kind]}
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

      {effectActive ? (
        <div data-slot="rect-effect-strength">
          <SliderRow
            display={t("annotate.effectStrengthValue", {
              strength: style.effect.strength,
            })}
            label={t("annotate.effectStrength")}
            max={RECT_MAX_EFFECT_STRENGTH}
            min={RECT_MIN_EFFECT_STRENGTH}
            onChange={(strength) =>
              onChange({ ...style, effect: { ...style.effect, strength } })
            }
            step={1}
            value={style.effect.strength}
          />
        </div>
      ) : null}

      {!effectActive ? (
        <div className="flex flex-col gap-3" data-slot="rect-vector-style">
          <div className="flex flex-col gap-1.5" data-slot="rect-stroke-colors">
            <p className="text-xs font-medium" id="rect-stroke-label">
              {t("annotate.strokeColor")}
            </p>
            {/* Only offer "none" for the border while the fill is holding the
                shape up: a rectangle with neither would draw nothing, and the
                backend rejects it. The last visible part cannot be removed. */}
            <ColorSwatchPicker
              allowNone
              labelledBy="rect-stroke-label"
              noneDisabled={style.fillColor === null}
              onChange={(color) => onChange({ ...style, strokeColor: color })}
              swatches={rectStrokeSwatches}
              value={style.strokeColor}
            />
          </div>

          <div className="flex flex-col gap-1.5" data-slot="rect-fill-colors">
            <p className="text-xs font-medium" id="rect-fill-label">
              {t("annotate.fillColor")}
            </p>
            <ColorSwatchPicker
              allowNone
              labelledBy="rect-fill-label"
              noneDisabled={style.strokeColor === null}
              onChange={(color) => onChange({ ...style, fillColor: color })}
              swatches={rectFillSwatches}
              value={style.fillColor}
            />
          </div>

          {style.strokeColor !== null ? (
            <div data-slot="rect-stroke-width">
              <SliderRow
                display={`${style.strokeWidth}`}
                label={t("annotate.strokeWidth")}
                max={RECT_MAX_STROKE_WIDTH}
                min={RECT_MIN_STROKE_WIDTH}
                onChange={(value) => onChange({ ...style, strokeWidth: value })}
                step={1}
                value={style.strokeWidth}
              />
            </div>
          ) : null}

          <div data-slot="rect-opacity">
            <SliderRow
              display={`${Math.round(style.opacity * 100)}%`}
              label={t("annotate.opacity")}
              max={100}
              min={RECT_MIN_OPACITY * 100}
              onChange={(value) => onChange({ ...style, opacity: value / 100 })}
              step={5}
              value={Math.round(style.opacity * 100)}
            />
          </div>

          <div data-slot="rect-corner-radius">
            <SliderRow
              display={`${style.cornerRadius}`}
              label={t("annotate.cornerRadius")}
              max={RECT_MAX_CORNER_RADIUS}
              min={0}
              onChange={(value) => onChange({ ...style, cornerRadius: value })}
              step={1}
              value={style.cornerRadius}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
