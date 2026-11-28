import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

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
  /** Keeps the tooltip shut without unmounting the trigger, preserving focus
      and active pointer interactions. */
  disabled?: boolean
  inDelayGroup?: boolean
  label: string | undefined
  /** Whether a focus opens it, as for a reader arriving by keyboard. Off where
      the app moves focus itself and the hint would then stand open. */
  openOnFocus?: boolean
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: ComponentProps<typeof TooltipContent>["sideOffset"]
  trackCursorAxis?: ComponentProps<typeof Tooltip>["trackCursorAxis"]
}

/** Whether text on screen is cut short, measured as a tooltip repeating it is
    about to open rather than as the text is laid out. */
export function isCutShort(text: HTMLElement | null | undefined) {
  return text !== null && text !== undefined && text.scrollWidth > text.clientWidth
}

export function HintTooltipGroup({ children }: { children: ReactNode }) {
  return <TooltipProvider delay={HINT_TOOLTIP_DELAY}>{children}</TooltipProvider>
}

type SharedHint = {
  label: string
  side: NonNullable<HintTooltipProps["side"]>
  sideOffset: HintTooltipProps["sideOffset"]
}

const SharedHintContext = createContext<TooltipPrimitive.Handle<SharedHint> | null>(null)

/** One tooltip for the plain hints of a long list, each hint only a trigger
    for it: a tooltip of its own per row or page made every one of them a
    tooltip root to render, mount and keep, hundreds at a time, as the sidebar
    widened or the outline filled. */
export function SharedHintTooltips({ children }: { children: ReactNode }) {
  const [handle] = useState(() => TooltipPrimitive.createHandle<SharedHint>())

  return (
    <SharedHintContext.Provider value={handle}>
      {children}
      <TooltipPrimitive.Root disableHoverablePopup handle={handle}>
        {({ payload }) =>
          payload ? (
            <TooltipContent side={payload.side} sideOffset={payload.sideOffset}>
              {payload.label}
            </TooltipContent>
          ) : null
        }
      </TooltipPrimitive.Root>
    </SharedHintContext.Provider>
  )
}

/** What content inside the app says under a resting pointer; the bars' own
    controls answer faster — see `ToolbarTooltip`. */
export function HintTooltip({
  children,
  cutShort,
  disabled,
  inDelayGroup = false,
  label,
  openOnFocus = true,
  side = "top",
  sideOffset,
  trackCursorAxis,
}: HintTooltipProps) {
  const shared = useContext(SharedHintContext)

  if (!label) {
    return children
  }

  // Only a plain hint can share: the others decide per opening, or need their
  // own root so disabling closes an open popup without remounting the trigger.
  // A trigger takes its delay from the provider around it, as a hint of its
  // own does.
  if (shared && !cutShort && disabled === undefined && openOnFocus && !trackCursorAxis) {
    const trigger = (
      <TooltipTrigger
        handle={shared}
        payload={{ label, side, sideOffset }}
        render={children}
      />
    )

    return inDelayGroup ? trigger : <HintTooltipGroup>{trigger}</HintTooltipGroup>
  }

  const repeatsWhatShows = () => cutShort !== undefined && !isCutShort(cutShort.current)

  // The hint stands over its neighbours, and what is under it has to stay
  // clickable, so the popup takes no pointer of its own.
  const tooltip = (
    <Tooltip
      disabled={disabled}
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
      trackCursorAxis={trackCursorAxis}
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
