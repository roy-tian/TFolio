import { useEffect, useRef, type RefObject } from "react"

import type { RectDraft } from "@/hooks/useRectTool"
import {
  createRectEffectPreviewBuffers,
  drawRectEffectPreview,
  type RectEffectPreviewBuffers,
} from "@/lib/rectEffectPreview"

type RectDraftOverlayProps = {
  draft: RectDraft
  pageWidth: number
  /** On-screen pixels per page point, to size the border and corners to match. */
  pxPerPoint: number
  rotation: number
  sourceCanvasRef: RefObject<HTMLCanvasElement | null>
  /** Incremented after fresh pixels have actually landed on the source canvas. */
  sourceRevision: number
}

/**
 * The live preview of the rectangle being dragged. It sits in the page's own
 * axis-aligned box and is positioned as fractions of it. Ordinary rectangles
 * use CSS; effects copy the already-rendered page canvas into a local preview,
 * so pointer movement never crosses the IPC boundary.
 */
export function RectDraftOverlay({
  draft,
  pageWidth,
  pxPerPoint,
  rotation,
  sourceCanvasRef,
  sourceRevision,
}: RectDraftOverlayProps) {
  const { rect, style } = draft
  const previewRef = useRef<HTMLCanvasElement>(null)
  const buffersRef = useRef<RectEffectPreviewBuffers | null>(null)
  const strokePx = style.strokeColor ? style.strokeWidth * pxPerPoint : 0
  const radiusPx = style.cornerRadius * pxPerPoint
  const effectActive = style.effect.kind !== "none"

  useEffect(() => {
    if (!effectActive || pageWidth <= 0 || sourceRevision <= 0) {
      return
    }

    const frame = requestAnimationFrame(() => {
      const preview = previewRef.current
      const source = sourceCanvasRef.current

      if (!preview || !source) {
        return
      }

      buffersRef.current ??= createRectEffectPreviewBuffers()
      drawRectEffectPreview(
        preview,
        source,
        rect,
        style.effect,
        rotation,
        source.width / pageWidth,
        buffersRef.current,
      )
    })

    return () => cancelAnimationFrame(frame)
  }, [
    effectActive,
    pageWidth,
    rect,
    rotation,
    sourceCanvasRef,
    sourceRevision,
    style.effect,
  ])

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        backgroundColor: effectActive ? undefined : (style.fillColor ?? undefined),
        border: !effectActive && style.strokeColor
          ? `${strokePx}px solid ${style.strokeColor}`
          : undefined,
        borderRadius: !effectActive && radiusPx > 0 ? `${radiusPx}px` : undefined,
        boxSizing: "border-box",
        height: `${rect.height * 100}%`,
        left: `${rect.left * 100}%`,
        opacity: effectActive ? 1 : style.opacity,
        overflow: "hidden",
        top: `${rect.top * 100}%`,
        width: `${rect.width * 100}%`,
      }}
    >
      {effectActive ? (
        <canvas
          className="block size-full"
          data-slot="rect-effect-preview"
          ref={previewRef}
        />
      ) : null}
    </div>
  )
}
