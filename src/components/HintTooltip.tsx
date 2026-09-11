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
  label: string | undefined
  /** Whether a focus opens it, as for a reader arriving by keyboard. Off where
      the app moves focus itself and the hint would then stand open. */
  openOnFocus?: boolean
  side?: "top" | "bottom" | "left" | "right"
}

/** What content inside the app says under a resting pointer; the bars' own
    controls answer faster — see `ToolbarTooltip`. */
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
    // A delay group's own delay governs every trigger inside it: under the
    // app's instant one, a trigger `delay` is ignored and the hint opens at once.
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
