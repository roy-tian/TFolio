import type { ReactElement, RefObject } from "react"

import { isCutShort } from "@/components/HintTooltip"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatShortcut, type Shortcut } from "@/lib/shortcuts"

type ToolbarTooltipProps = {
  children: ReactElement
  /** The text on screen that the label only repeats: the tooltip then opens
      only while that text is cut short. */
  cutShort?: RefObject<HTMLElement | null>
  /** Keeps the tooltip shut, and shuts it if open, without remounting the
      trigger, which would drop its focus. */
  disabled?: boolean
  label: string
  /** The chord this control also answers to, named beside its label. Left off
      where the label already explains why the control is unavailable. */
  shortcut?: Shortcut
  side?: "top" | "bottom" | "left" | "right"
}

export function ToolbarTooltip({
  children,
  cutShort,
  disabled = false,
  label,
  shortcut,
  side = "bottom",
}: ToolbarTooltipProps) {
  return (
    <Tooltip
      disabled={disabled}
      onOpenChange={(open, details) => {
        if (open && cutShort && !isCutShort(cutShort.current)) {
          details.cancel()
        }
      }}
    >
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {shortcut ? <Kbd>{formatShortcut(shortcut)}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  )
}
