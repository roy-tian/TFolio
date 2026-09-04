import type { ReactElement } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ToolbarTooltipProps = {
  children: ReactElement
  label: string
}

/** A toolbar control's visible label, sharing the shadcn tooltip treatment. */
export function ToolbarTooltip({ children, label }: ToolbarTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
