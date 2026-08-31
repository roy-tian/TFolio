import { useEffect, useRef, useState } from "react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// Long enough to read a figure that arrived while the reader was looking at the
// page rather than at the toolbar, short enough not to sit over it.
const HOLD_MS = 900

type ZoomIndicatorProps = {
  /** Bumped by every zoom the reader asks for — a button, or a pinch settling
   *  — including one that resolves to the level already showing: pressing `+`
   *  at the maximum still answers. */
  flash: number
  percent: number
}

/**
 * The zoom level, flashed over the middle of the viewport and faded out again.
 * It answers the button that was just pressed, where a permanent readout in the
 * toolbar would sit there being read long after anyone cared.
 *
 * Silent to a screen reader: the level is already on the zoom group's own name,
 * which is where a reader who cannot see this looks for it.
 */
export function ZoomIndicator({ flash, percent }: ZoomIndicatorProps) {
  const [visible, setVisible] = useState(false)
  // What was last answered, so only a *turn* of the counter flashes. Seeded
  // from the counter as it stands, because a mount is not a zoom: the reader
  // opening a document, or coming back to the page from the thumbnail grid,
  // asked for no level and must not be shown one.
  const answeredRef = useRef(flash)

  useEffect(() => {
    if (flash === answeredRef.current) {
      return
    }

    answeredRef.current = flash
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), HOLD_MS)

    return () => clearTimeout(timer)
  }, [flash])

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-20 grid place-items-center transition-opacity",
        // In at once, out slowly: the answer has to beat the eye moving back to
        // the page, and the fade must not read as a second event.
        visible ? "opacity-100 duration-75" : "opacity-0 duration-500",
      )}
      data-slot="zoom-indicator"
      data-visible={visible}
    >
      {/* Dark in both themes, unlike everything else in the app. What this sits
          over is the page, not the chrome: paper is light whichever theme is
          on, so a card that followed the theme would be white on white the
          moment the reader was in daylight mode. */}
      <Card className="bg-zinc-900/75 text-zinc-50 shadow-xl ring-white/15 backdrop-blur-sm">
        <CardContent className="font-mono text-2xl font-semibold tabular-nums">
          {percent}%
        </CardContent>
      </Card>
    </div>
  )
}
