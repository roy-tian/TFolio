import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { SliderRow } from "@/components/SliderRow"
import type { RectStyle } from "@/lib/annotations"
import {
  RECT_MAX_CORNER_RADIUS,
  RECT_MAX_STROKE_WIDTH,
  RECT_MIN_OPACITY,
  RECT_MIN_STROKE_WIDTH,
  rectFillSwatches,
  rectStrokeSwatches,
} from "@/lib/annotationStyles"

type RectStylePopoverProps = {
  onChange: (style: RectStyle) => void
  style: RectStyle
}

/**
 * The rectangle tool's options panel: a border colour and a fill colour, either
 * of which can be "none", and sliders for the parts that are not a colour. The
 * shape here is deliberately open for M5 to add its blur and mosaic effects.
 */
export function RectStylePopover({ onChange, style }: RectStylePopoverProps) {
  const { t } = useTranslation()

  return (
    <div className="flex w-56 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium" id="rect-stroke-label">
          {t("annotate.strokeColor")}
        </p>
        {/* Only offer "none" for the border while the fill is holding the
            shape up: a rectangle with neither would draw nothing, and the
            backend rejects it. The last visible part cannot be removed. */}
        <ColorSwatchPicker
          allowNone={style.fillColor !== null}
          labelledBy="rect-stroke-label"
          onChange={(color) => onChange({ ...style, strokeColor: color })}
          swatches={rectStrokeSwatches}
          value={style.strokeColor}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium" id="rect-fill-label">
          {t("annotate.fillColor")}
        </p>
        <ColorSwatchPicker
          allowNone={style.strokeColor !== null}
          labelledBy="rect-fill-label"
          onChange={(color) => onChange({ ...style, fillColor: color })}
          swatches={rectFillSwatches}
          value={style.fillColor}
        />
      </div>

      <SliderRow
        disabled={style.strokeColor === null}
        display={`${style.strokeWidth}`}
        label={t("annotate.strokeWidth")}
        max={RECT_MAX_STROKE_WIDTH}
        min={RECT_MIN_STROKE_WIDTH}
        onChange={(value) => onChange({ ...style, strokeWidth: value })}
        step={1}
        value={style.strokeWidth}
      />

      <SliderRow
        display={`${style.cornerRadius}`}
        label={t("annotate.cornerRadius")}
        max={RECT_MAX_CORNER_RADIUS}
        min={0}
        onChange={(value) => onChange({ ...style, cornerRadius: value })}
        step={1}
        value={style.cornerRadius}
      />

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
  )
}
