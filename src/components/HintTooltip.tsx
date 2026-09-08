import type { ReactElement } from "react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// Content is crossed on the way somewhere rather than aimed at the way a bar's
// controls are, so the hint waits for a hover that means it.
const HINT_TOOLTIP_DELAY = 600

type HintTooltipProps = {
  children: ReactElement
  /** Absent where the hint is conditional: nothing to say, nothing to open. */
  label: string | undefined
  /** Whether a focus opens it, as it does for a reader arriving by keyboard.
      Off where the app moves focus itself and the hint would then stand open
      until something else took the focus away. */
  openOnFocus?: boolean
  /** Where the hint sits; above what it names unless that is off the screen. */
  side?: "top" | "bottom" | "left" | "right"
}

/**
 * What a control or a truncated line inside the app's content says when the
 * pointer rests on it — a page in the grid, a file in a list, a tab's whole
 * name. The bars' own controls answer faster: see `ToolbarTooltip`.
 */
export function HintTooltip({
  children,
  label,
  openOnFocus = true,
  side = "top",
}: HintTooltipProps) {
  if (!label) {
    return children
  }

  return (
    // A delay group's own delay governs every trigger inside it, so the hint
    // needs a group of its own: under the app's instant one a trigger `delay`
    // is ignored and the hint would open the moment the pointer crossed it.
    <TooltipProvider delay={HINT_TOOLTIP_DELAY}>
      {/* The hint stands over its neighbours, and what is under it has to stay
          clickable, so the popup takes no pointer of its own. */}
      <Tooltip
        disableHoverablePopup
        onOpenChange={(open, details) => {
          // A focus the app moves itself is not a reader asking to read.
          if (open && !openOnFocus && details.reason === "trigger-focus") {
            details.cancel()
          }
        }}
      >
        <TooltipTrigger render={children} />
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
