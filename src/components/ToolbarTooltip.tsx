import type { ReactElement } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ToolbarTooltipProps = {
  children: ReactElement
  label: string
  /** Where the label sits; under the control, as a top bar's controls want. */
  side?: "top" | "bottom" | "left" | "right"
}

/** A bar control's visible label, sharing the shadcn tooltip treatment. */
export function ToolbarTooltip({
  children,
  label,
  side = "bottom",
}: ToolbarTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
