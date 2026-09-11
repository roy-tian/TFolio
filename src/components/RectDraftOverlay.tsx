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
  rotation: number
  sourceCanvasRef: RefObject<HTMLCanvasElement | null>
  /** Incremented after fresh pixels have actually landed on the source canvas. */
  sourceRevision: number
}

/**
 * The live preview of the rectangle being dragged. It sits in the page's own
 * axis-aligned box and is positioned as fractions of it. A translucent block is
 * CSS; a blur or a mosaic copies the already-rendered page canvas into a local
 * preview, so pointer movement never crosses the IPC boundary.
 */
export function RectDraftOverlay({
  draft,
  pageWidth,
  rotation,
  sourceCanvasRef,
  sourceRevision,
}: RectDraftOverlayProps) {
  const { rect, style } = draft
  const previewRef = useRef<HTMLCanvasElement>(null)
  const buffersRef = useRef<RectEffectPreviewBuffers | null>(null)
  const effect = style.effect
  const treatsPixels = effect !== "translucent"

  useEffect(() => {
    if (effect === "translucent" || pageWidth <= 0 || sourceRevision <= 0) {
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
        { kind: effect, strength: style.strength },
        rotation,
        source.width / pageWidth,
        buffersRef.current,
      )
    })

    return () => cancelAnimationFrame(frame)
  }, [
    effect,
    pageWidth,
    rect,
    rotation,
    sourceCanvasRef,
    sourceRevision,
    style.strength,
  ])

  return (
    <div
      className="pointer-events-none absolute"
      data-slot="rect-draft-preview"
      style={{
        backgroundColor: treatsPixels ? undefined : style.color,
        height: `${rect.height * 100}%`,
        left: `${rect.left * 100}%`,
        opacity: treatsPixels ? 1 : style.opacity,
        overflow: "hidden",
        top: `${rect.top * 100}%`,
        width: `${rect.width * 100}%`,
      }}
    >
      {treatsPixels ? (
        <canvas
          className="block size-full"
          data-slot="rect-effect-preview"
          ref={previewRef}
        />
      ) : null}
    </div>
  )
}
