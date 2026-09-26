import { useLayoutEffect, useRef, useState } from "react"

import { usesEmbeddedFont } from "@/lib/embeddedFont"
import {
  watermarkFontSize,
  watermarkRotation,
  watermarkZebraSpacing,
  WATERMARK_COLOR,
  WATERMARK_OPACITY,
  WATERMARK_REFERENCE_FONT_SIZE,
  type WatermarkConfig,
  type WatermarkLayout,
} from "@/lib/watermark"

/** A4 in points: the sheet the preview stands in for where there is no page
    yet to take one from — the merge wizard's. Sizes read as pt either way. */
const A4_SHEET = { height: 841.89, width: 595.276 }

/** Mirrors the backend's per-page ceiling so a dense grid cannot flood the DOM. */
const MAX_PREVIEW_TILES = 512

type Placement = { x: number; y: number }

function stepsToCover(distance: number, step: number) {
  return Math.min(Math.ceil(distance / step), MAX_PREVIEW_TILES)
}

type Box = { height: number; width: number }

/** Mirrors `watermark_placements` in `src-tauri/src/pdfium/watermark.rs`, as an
    approximation — PDFium measures real glyphs — so a mismatch is a preview bug. */
function previewPlacements(
  sheet: Box,
  tile: Box,
  spacing: number,
  layout: WatermarkLayout,
): Placement[] {
  if (layout === "single") {
    return [{ x: sheet.width / 2, y: sheet.height / 2 }]
  }

  const stepX = tile.width + spacing
  const stepY = tile.height + spacing

  if (!(stepX > 0) || !(stepY > 0)) {
    return []
  }

  // The grid hangs on the middle of the sheet, so a mark too big to repeat
  // inside it still leaves one whole copy where a single mark would have been.
  const middleX = sheet.width / 2
  const middleY = sheet.height / 2
  const columns = stepsToCover(middleX + tile.width, stepX)
  const rows = stepsToCover(middleY + tile.height, stepY)
  const placements: Placement[] = []

  for (let row = -rows; row <= rows; row += 1) {
    // The half-step shift costs its half at the left edge, so the extra column
    // goes there — the shift itself already covers the right.
    const offset = row % 2 === 0 ? 0 : stepX / 2

    for (let column = -columns - 1; column <= columns; column += 1) {
      if (placements.length >= MAX_PREVIEW_TILES) {
        return placements
      }

      placements.push({
        x: middleX + column * stepX + offset,
        y: middleY + row * stepY,
      })
    }
  }

  return placements
}

type WatermarkPreviewProps = {
  config: WatermarkConfig
  placeholder: string
  /** The page the mark is previewed on, as displayed, in points. */
  page?: Box
}

export function WatermarkPreview({
  config,
  page = A4_SHEET,
  placeholder,
}: WatermarkPreviewProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [sheetWidth, setSheetWidth] = useState(0)
  const [referenceBox, setReferenceBox] = useState<Box>({
    height: 0,
    width: 0,
  })

  useLayoutEffect(() => {
    const node = sheetRef.current

    if (!node) {
      return
    }

    const observer = new ResizeObserver(([entry]) => {
      setSheetWidth(entry.contentRect.width)
    })

    observer.observe(node)

    return () => observer.disconnect()
  }, [])

  const scale = sheetWidth / page.width
  const sheet = {
    height: sheetWidth * (page.height / page.width),
    width: sheetWidth,
  }
  const embedded = usesEmbeddedFont(config.text)
  const text = config.text || placeholder
  const fontFamily = embedded ? "sans-serif" : "Helvetica, Arial, sans-serif"
  const rotation = `rotate(${watermarkRotation(config.direction, page.width, page.height)}deg)`
  const referenceFontSize = WATERMARK_REFERENCE_FONT_SIZE * scale

  // The rotated box feeds both size and grid; a client rect already carries the
  // transform, so measure it — once at the reference size, since text scales.
  useLayoutEffect(() => {
    const node = measureRef.current
    const sheetNode = sheetRef.current

    if (!node || !sheetNode) {
      return
    }

    // The dialog's open animation scales this subtree; a client rect carries
    // that, a layout size does not — divide the scale back out before using it.
    const rendered = sheetNode.getBoundingClientRect().width
    const laidOut = sheetNode.offsetWidth
    const transform = laidOut > 0 && rendered > 0 ? rendered / laidOut : 1
    const rect = node.getBoundingClientRect()

    setReferenceBox({
      height: rect.height / transform,
      width: rect.width / transform,
    })
  }, [fontFamily, referenceFontSize, rotation, text])

  const fontSize = watermarkFontSize(
    config.widthRatio,
    page.width,
    referenceBox.width / (scale || 1),
  )
  const drawn = fontSize / WATERMARK_REFERENCE_FONT_SIZE
  const placements = previewPlacements(
    sheet,
    { height: referenceBox.height * drawn, width: referenceBox.width * drawn },
    watermarkZebraSpacing(fontSize) * scale,
    config.layout,
  )

  return (
    <div
      className="relative mx-auto overflow-hidden rounded-md border bg-white shadow-sm"
      data-testid="watermark-sheet"
      ref={sheetRef}
      style={{
        aspectRatio: page.width / page.height,
        // Never taller than A4 at full width: a receipt-thin page would
        // otherwise stretch the dialog many screens down.
        width: `${Math.min(1, (page.width / page.height) / (A4_SHEET.width / A4_SHEET.height)) * 100}%`,
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 whitespace-nowrap opacity-0"
        ref={measureRef}
        style={{
          fontFamily,
          fontSize: `${referenceFontSize}px`,
          lineHeight: 1,
          transform: rotation,
        }}
      >
        {text}
      </span>

      {placements.map((placement, index) => (
        <span
          className="pointer-events-none absolute whitespace-nowrap"
          data-testid={index === 0 ? "watermark-preview" : undefined}
          key={index}
          style={{
            color: WATERMARK_COLOR,
            fontFamily,
            fontSize: `${fontSize * scale}px`,
            left: `${placement.x}px`,
            lineHeight: 1,
            opacity: WATERMARK_OPACITY,
            top: `${placement.y}px`,
            transform: `translate(-50%, -50%) ${rotation}`,
          }}
        >
          {text}
        </span>
      ))}
    </div>
  )
}
