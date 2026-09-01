import { useLayoutEffect, useRef, useState } from "react"

import {
  watermarkFontSize,
  watermarkRotation,
  watermarkUsesEmbeddedFont,
  watermarkZebraSpacing,
  WATERMARK_COLOR,
  WATERMARK_OPACITY,
  WATERMARK_REFERENCE_FONT_SIZE,
  type WatermarkConfig,
  type WatermarkLayout,
} from "@/lib/watermark"

/** A4 in points: the sheet the preview stands in for, so sizes read as pt. */
const A4_WIDTH = 595.276
const A4_HEIGHT = 841.89

/** Mirrors the backend's per-page ceiling so a dense grid cannot flood the DOM. */
const MAX_PREVIEW_TILES = 512

type Placement = { x: number; y: number }

function stepsToCover(distance: number, step: number) {
  return Math.min(Math.ceil(distance / step), MAX_PREVIEW_TILES)
}

type Box = { height: number; width: number }

/**
 * Mirrors `watermark_placements` in `src-tauri/src/pdfium/watermark.rs`: tiles
 * step by the rotated text box plus the spacing, and odd rows shift half a step.
 * An approximation of the real thing — PDFium measures the glyphs the page will
 * actually carry, on the page's own box rather than this A4 stand-in — so treat
 * a mismatch here as a preview bug, not a page bug.
 */
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
  /** Stand-in mark for an empty draft, so the sheet is never blank. */
  placeholder: string
}

export function WatermarkPreview({ config, placeholder }: WatermarkPreviewProps) {
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

  const scale = sheetWidth / A4_WIDTH
  const sheet = {
    height: sheetWidth * (A4_HEIGHT / A4_WIDTH),
    width: sheetWidth,
  }
  const embedded = watermarkUsesEmbeddedFont(config.text)
  const text = config.text || placeholder
  const fontFamily = embedded ? "sans-serif" : "Helvetica, Arial, sans-serif"
  const rotation = `rotate(${watermarkRotation(config.direction, A4_WIDTH, A4_HEIGHT)}deg)`
  const referenceFontSize = WATERMARK_REFERENCE_FONT_SIZE * scale

  // The rotated box is what both the size and the grid are derived from, and a
  // client rect already accounts for the transform — so measure rather than
  // derive it. One measurement at the reference size is enough: text scales
  // with its font size, which is what the backend leans on too.
  useLayoutEffect(() => {
    const node = measureRef.current
    const sheetNode = sheetRef.current

    if (!node || !sheetNode) {
      return
    }

    // A client rect carries every ancestor transform, and the dialog scales this
    // whole subtree while it opens; `sheetWidth` is a layout size, which does
    // not. Divide that scale back out against the sheet's own two widths, or the
    // mark keeps whatever the animation was mid-way through when it measured.
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
    A4_WIDTH,
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
      className="relative aspect-[210/297] w-full overflow-hidden rounded-md border bg-white shadow-sm"
      data-testid="watermark-sheet"
      ref={sheetRef}
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
