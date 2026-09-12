import { useEffect, useRef, useState } from "react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// Long enough to read a figure that arrived while the reader was looking at the
// page rather than at the toolbar, short enough not to sit over it.
const HOLD_MS = 900

type ZoomIndicatorProps = {
  /** Bumped by every zoom the reader asks for, including one that resolves to
      the level already showing: pressing `+` at the maximum still answers. */
  flash: number
  percent: number
}

/** Flashed over the viewport then faded: it answers the press just made, where
    a permanent toolbar readout would sit there being read long after. */
export function ZoomIndicator({ flash, percent }: ZoomIndicatorProps) {
  const [visible, setVisible] = useState(false)
  // Seeded from the counter as it stands, because a mount is not a zoom: only a
  // *turn* of the counter may flash.
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
      {/* Dark in both themes: this sits over the page, and paper is light
          whichever theme is on — a themed card would be white on white. */}
      <Card className="bg-zinc-900/75 text-zinc-50 shadow-xl ring-white/15 backdrop-blur-sm">
        <CardContent className="font-mono text-2xl font-semibold tabular-nums">
          {percent}%
        </CardContent>
      </Card>
    </div>
  )
}
