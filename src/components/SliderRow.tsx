import { useId } from "react"

import { Slider } from "@/components/ui/slider"

type SliderRowProps = {
  disabled?: boolean
  display: string
  label: string
  max: number
  min: number
  /** `transient` for each step of a drag, which is shown but not stored;
      the value the drag lets go on comes again, not transient. */
  onChange: (value: number, transient: boolean) => void
  step: number
  value: number
}

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
          onChange(Array.isArray(next) ? (next[0] ?? min) : (next as number), true)
        }
        onValueCommitted={(next) =>
          onChange(
            Array.isArray(next) ? (next[0] ?? min) : (next as number),
            false,
          )
        }
        step={step}
        value={[value]}
      />
    </div>
  )
}
