import { Minus, Plus } from "lucide-react"
import { useState } from "react"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import type { Shortcut } from "@/lib/shortcuts"

type SliderStepperProps = {
  canDecrease: boolean
  canIncrease: boolean
  decrease: { label: string; shortcut?: Shortcut }
  disabled?: boolean
  /** Names the whole control; a level put here stays readable at any time. */
  groupLabel: string
  increase: { label: string; shortcut?: Shortcut }
  max: number
  min: number
  /** The drag let go, or a key moved the thumb. */
  onCommit: (value: number) => void
  onDecrease: () => void
  onIncrease: () => void
  /** Every step of a drag, before it is let go. */
  onPreview: (value: number) => void
  /** Beside the plus button, following the thumb while it is dragged. */
  readout?: (value: number) => string
  sliderLabel: string
  slot: string
  value: number
  valueText: (value: number) => string
}

// Base UI hands back an array for a slider given one, as this one always is.
function firstValue(next: number | readonly number[], fallback: number) {
  return Array.isArray(next) ? (next[0] ?? fallback) : (next as number)
}

/** A minus button, a slider and a plus button: the buttons step to the next
    rung, the slider travels anywhere between. */
export function SliderStepper({
  canDecrease,
  canIncrease,
  decrease,
  disabled = false,
  groupLabel,
  increase,
  max,
  min,
  onCommit,
  onDecrease,
  onIncrease,
  onPreview,
  readout,
  sliderLabel,
  slot,
  value,
  valueText,
}: SliderStepperProps) {
  // The owner may only take a drag in once it is let go, so the thumb and the
  // readout follow the pointer from here meanwhile.
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = dragValue ?? value

  return (
    <div
      aria-label={groupLabel}
      className="flex items-center gap-1"
      data-slot={slot}
      role="group"
    >
      <ToolbarTooltip label={decrease.label} shortcut={decrease.shortcut}>
        <Button
          aria-label={decrease.label}
          disabled={disabled || !canDecrease}
          onClick={() => onDecrease()}
          size="icon-sm"
          variant="ghost"
        >
          <Minus />
        </Button>
      </ToolbarTooltip>
      {/* An array of one: a scalar makes the wrapper draw a two-thumb range.
          The width needs the wrapper's own `data-horizontal:` to outrank it.
          Centre alignment places the thumb by percentage alone: edge alignment
          measures it first and hides it until then, which a slider mounted in
          a hidden tab or workspace never gets to do. The padding holds the
          half thumb that overhangs at either end. */}
      <Slider
        className="px-1.5 data-horizontal:w-28"
        thumbAlignment="center"
        disabled={disabled}
        max={max}
        min={min}
        onValueChange={(next) => {
          const step = firstValue(next, min)
          setDragValue(step)
          onPreview(step)
        }}
        onValueCommitted={(next) => {
          setDragValue(null)
          onCommit(firstValue(next, min))
        }}
        thumbProps={{
          getAriaLabel: () => sliderLabel,
          getAriaValueText: (_formatted, step) => valueText(step),
        }}
        value={[shown]}
      />
      <ToolbarTooltip label={increase.label} shortcut={increase.shortcut}>
        <Button
          aria-label={increase.label}
          disabled={disabled || !canIncrease}
          onClick={() => onIncrease()}
          size="icon-sm"
          variant="ghost"
        >
          <Plus />
        </Button>
      </ToolbarTooltip>
      {readout ? (
        <span
          aria-hidden
          className="w-12 text-center font-mono text-xs tabular-nums text-muted-foreground"
          data-slot={`${slot}-readout`}
        >
          {readout(shown)}
        </span>
      ) : null}
    </div>
  )
}
