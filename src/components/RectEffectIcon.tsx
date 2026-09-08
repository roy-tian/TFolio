import { createLucideIcon, Icon, type IconNode, Square } from "lucide-react"
import { useId } from "react"

import type { RectEffectKind } from "@/lib/annotations"

/** Lucide's own `Square`, so an effect's icon keeps the plain one's frame and
    only fills it with what that effect leaves on the page. */
const frameNode: IconNode = [
  ["rect", { height: "18", key: "frame", rx: "2", width: "18", x: "3", y: "3" }],
]

/** A checkerboard coarse enough to still read as blocks at 16px. */
const RectMosaicIcon = createLucideIcon("rect-mosaic", [
  ...frameNode,
  [
    "path",
    {
      d: "M4.5 4.5h5v5h-5zM14.5 4.5h5v5h-5zM9.5 9.5h5v5h-5zM4.5 14.5h5v5h-5zM14.5 14.5h5v5h-5z",
      fill: "currentColor",
      key: "cells",
      stroke: "none",
    },
  ],
])

function RectBlurIcon() {
  // The filter is referenced by id, which is document-wide: two icons on one
  // page must not share it.
  const filterId = `rect-blur-${useId().replace(/[^a-z0-9]/gi, "")}`

  return (
    <Icon aria-hidden="true" className="lucide-rect-blur" iconNode={frameNode}>
      <defs key="defs">
        {/* The default region is only a tenth wider than the source box, which
            cuts a spread of three sigma off well before it fades out. */}
        <filter height="200%" id={filterId} width="200%" x="-50%" y="-50%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <rect
        fill="currentColor"
        filter={`url(#${filterId})`}
        height="10"
        key="haze"
        rx="1"
        stroke="none"
        width="10"
        x="7"
        y="7"
      />
    </Icon>
  )
}

/** The rectangle tool's icon, drawn as the mark the current effect would make
    rather than as a box whichever effect is armed. */
export function RectEffectIcon({ effect }: { effect: RectEffectKind }) {
  if (effect === "blur") {
    return <RectBlurIcon />
  }

  if (effect === "mosaic") {
    return <RectMosaicIcon />
  }

  return <Square />
}
