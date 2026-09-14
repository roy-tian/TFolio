import type { ReactElement, ReactNode } from "react"

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
  inDelayGroup?: boolean
  label: string | undefined
  /** Whether a focus opens it, as for a reader arriving by keyboard. Off where
      the app moves focus itself and the hint would then stand open. */
  openOnFocus?: boolean
  side?: "top" | "bottom" | "left" | "right"
}

export function HintTooltipGroup({ children }: { children: ReactNode }) {
  return <TooltipProvider delay={HINT_TOOLTIP_DELAY}>{children}</TooltipProvider>
}

/** What content inside the app says under a resting pointer; the bars' own
    controls answer faster — see `ToolbarTooltip`. */
export function HintTooltip({
  children,
  inDelayGroup = false,
  label,
  openOnFocus = true,
  side = "top",
}: HintTooltipProps) {
  if (!label) {
    return children
  }

  // The hint stands over its neighbours, and what is under it has to stay
  // clickable, so the popup takes no pointer of its own.
  const tooltip = (
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
  )

  // The app's instant provider overrides a trigger's delay, so isolated hints
  // need their own provider; grouped hints share the surrounding one.
  return inDelayGroup ? tooltip : <HintTooltipGroup>{tooltip}</HintTooltipGroup>
}
