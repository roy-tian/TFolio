import type { RectDraft } from "@/hooks/useRectTool"

type RectDraftOverlayProps = {
  draft: RectDraft
  /** On-screen pixels per page point, to size the border and corners to match. */
  pxPerPoint: number
}

/**
 * The live preview of the rectangle being dragged. It sits in the page's own
 * axis-aligned box and is positioned as fractions of it, so CSS gives an exact
 * preview — border, fill, opacity, and a rounded corner — for free, and the
 * committed annotation lands where the preview stood.
 */
export function RectDraftOverlay({ draft, pxPerPoint }: RectDraftOverlayProps) {
  const { rect, style } = draft
  const strokePx = style.strokeColor ? style.strokeWidth * pxPerPoint : 0
  const radiusPx = style.cornerRadius * pxPerPoint

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        backgroundColor: style.fillColor ?? undefined,
        border: style.strokeColor
          ? `${strokePx}px solid ${style.strokeColor}`
          : undefined,
        borderRadius: radiusPx > 0 ? `${radiusPx}px` : undefined,
        boxSizing: "border-box",
        height: `${rect.height * 100}%`,
        left: `${rect.left * 100}%`,
        opacity: style.opacity,
        top: `${rect.top * 100}%`,
        width: `${rect.width * 100}%`,
      }}
    />
  )
}
