import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import { Ban, Check } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { HexColor } from "@/lib/annotations"
import { isHexColor } from "@/lib/annotationStyles"

type ColorSwatchPickerProps = {
  /** Offers a "none" choice for a colour that can be left off, e.g. a fill. */
  allowNone?: boolean
  disabled?: boolean
  labelledBy: string
  /** Keeps "none" visible but unavailable when it would remove the last colour. */
  noneDisabled?: boolean
  onChange: (color: HexColor | null) => void
  swatches: readonly HexColor[]
  value: HexColor | null
}

// Base UI's RadioGroup keys on strings, so `null` needs a stand-in value.
const NONE_VALUE = "none"

/**
 * Swatches for the common cases, and `<input type="color">` for the rest rather
 * than a hand-built wheel — the platform already does it, with a keyboard and a
 * screen reader.
 */
export function ColorSwatchPicker({
  allowNone = false,
  disabled = false,
  labelledBy,
  noneDisabled = false,
  onChange,
  swatches,
  value,
}: ColorSwatchPickerProps) {
  const { t } = useTranslation()
  const isNone = value === null
  // A mixed colour has no swatch to check, so the custom well shows as chosen.
  const isCustom = value !== null && !swatches.includes(value)

  return (
    <div className="flex items-center gap-1.5">
      <RadioGroup
        aria-labelledby={labelledBy}
        className="flex items-center gap-1.5"
        disabled={disabled}
        onValueChange={(next) => {
          if (next === NONE_VALUE) {
            onChange(null)
          } else if (isHexColor(next)) {
            // Base UI hands back the `null` a mixed colour puts in; coercing it
            // would store the string "null" as the reader's colour.
            onChange(next)
          }
        }}
        value={isNone ? NONE_VALUE : isCustom ? null : value}
      >
        {allowNone ? (
          <Radio.Root
            aria-label={t("annotate.noColor")}
            className="flex size-6 items-center justify-center rounded-md border border-input text-muted-foreground outline-none transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:pointer-events-none data-disabled:opacity-40"
            disabled={noneDisabled}
            title={t("annotate.noColor")}
            value={NONE_VALUE}
          >
            <Ban className="size-4" />
          </Radio.Root>
        ) : null}
        {swatches.map((swatch) => (
          <Radio.Root
            aria-label={swatch}
            className="flex size-6 items-center justify-center rounded-md border border-black/10 outline-none transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-white/15"
            key={swatch}
            style={{ backgroundColor: swatch }}
            title={swatch}
            value={swatch}
          >
            <Radio.Indicator>
              {/* Mixed against the swatch: a tick has to stay visible on both a
                  pale yellow and a deep blue. */}
              <Check className="size-3.5 mix-blend-difference text-white" />
            </Radio.Indicator>
          </Radio.Root>
        ))}
      </RadioGroup>
      <label
        className="relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-input transition-colors hover:border-foreground/40 focus-within:ring-3 focus-within:ring-ring/50 data-disabled:pointer-events-none data-disabled:opacity-50"
        data-checked={isCustom || undefined}
        data-disabled={disabled || undefined}
        title={t("annotate.customColor")}
      >
        <input
          aria-label={t("annotate.customColor")}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={value ?? "#000000"}
        />
        <span
          aria-hidden
          className="size-full"
          style={{
            background: isCustom
              ? value
              : "conic-gradient(#f87171, #fbbf24, #4ade80, #38bdf8, #a78bfa, #f87171)",
          }}
        />
      </label>
    </div>
  )
}
