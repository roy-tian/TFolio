import type { ReactElement } from "react"

import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatShortcut, type Shortcut } from "@/lib/shortcuts"

type ToolbarTooltipProps = {
  children: ReactElement
  label: string
  /** The chord this control also answers to, named beside its label. Left off
      where the label already explains why the control is unavailable. */
  shortcut?: Shortcut
  side?: "top" | "bottom" | "left" | "right"
}

export function ToolbarTooltip({
  children,
  label,
  shortcut,
  side = "bottom",
}: ToolbarTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut ? <Kbd>{formatShortcut(shortcut)}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  )
}
