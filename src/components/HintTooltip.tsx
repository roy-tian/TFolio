import type { ComponentProps, ReactElement, ReactNode, RefObject } from "react"

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
  /** The text on screen that the label only repeats: the hint then opens
      only while that text is cut short. */
  cutShort?: RefObject<HTMLElement | null>
  inDelayGroup?: boolean
  label: string | undefined
  /** Whether a focus opens it, as for a reader arriving by keyboard. Off where
      the app moves focus itself and the hint would then stand open. */
  openOnFocus?: boolean
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"]
}

/** Whether text on screen is cut short, measured as a tooltip repeating it is
    about to open rather than as the text is laid out. */
export function isCutShort(text: HTMLElement | null | undefined) {
  return text !== null && text !== undefined && text.scrollWidth > text.clientWidth
}

export function HintTooltipGroup({ children }: { children: ReactNode }) {
  return <TooltipProvider delay={HINT_TOOLTIP_DELAY}>{children}</TooltipProvider>
}

/** What content inside the app says under a resting pointer; the bars' own
    controls answer faster — see `ToolbarTooltip`. */
export function HintTooltip({
  children,
  cutShort,
  inDelayGroup = false,
  label,
  openOnFocus = true,
  side = "top",
  sideOffset,
}: HintTooltipProps) {
  if (!label) {
    return children
  }

  const repeatsWhatShows = () => cutShort !== undefined && !isCutShort(cutShort.current)

  // The hint stands over its neighbours, and what is under it has to stay
  // clickable, so the popup takes no pointer of its own.
  const tooltip = (
    <Tooltip
      disableHoverablePopup
      onOpenChange={(open, details) => {
        // A focus the app moves itself is not a reader asking to read.
        if (
          open &&
          ((!openOnFocus && details.reason === "trigger-focus") || repeatsWhatShows())
        ) {
          details.cancel()
        }
      }}
    >
      <TooltipTrigger render={children} />
      <TooltipContent side={side} sideOffset={sideOffset}>
        {label}
      </TooltipContent>
    </Tooltip>
  )

  // The app's instant provider overrides a trigger's delay, so isolated hints
  // need their own provider; grouped hints share the surrounding one.
  return inDelayGroup ? tooltip : <HintTooltipGroup>{tooltip}</HintTooltipGroup>
}
