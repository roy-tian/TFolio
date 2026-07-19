import { useId } from "react"

import { Slider } from "@/components/ui/slider"

type SliderRowProps = {
  disabled?: boolean
  /** The value as the reader reads it — "12pt", "40%" — beside the label. */
  display: string
  label: string
  max: number
  min: number
  onChange: (value: number) => void
  step: number
  value: number
}

/** A labelled slider with its current value shown, as every options panel wants. */
export function SliderRow({
  disabled,
  display,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: SliderRowProps) {
  const labelId = useId()

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" id={labelId}>
          {label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{display}</span>
      </div>
      {/* An array of one: the slider is single-thumb, and a scalar value makes
          its wrapper fall back to a two-thumb `[min, max]` range. */}
      <Slider
        aria-labelledby={labelId}
        disabled={disabled}
        max={max}
        min={min}
        onValueChange={(next) =>
          onChange(Array.isArray(next) ? (next[0] ?? min) : (next as number))
        }
        step={step}
        value={[value]}
      />
    </div>
  )
}
