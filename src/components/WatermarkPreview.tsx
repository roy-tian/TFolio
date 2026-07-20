import { useLayoutEffect, useRef, useState } from "react"

import {
  watermarkUsesEmbeddedFont,
  type WatermarkConfig,
  type WatermarkFontFamily,
} from "@/lib/watermark"

/** A4 in points: the sheet the preview stands in for, so sizes read as pt. */
const A4_WIDTH = 595.276
const A4_HEIGHT = 841.89

/** Mirrors the backend's per-page ceiling so a dense grid cannot flood the DOM. */
const MAX_PREVIEW_TILES = 512

const previewFontFamily: Record<WatermarkFontFamily, string> = {
  mono: "ui-monospace, monospace",
  sans: "Helvetica, Arial, sans-serif",
  serif: "'Times New Roman', Times, serif",
}

type Placement = { x: number; y: number }

type Box = { height: number; width: number }

/**
 * Mirrors `watermark_placements` in `src-tauri/src/pdfium/watermark.rs`: tiles
 * step by the rotated text box plus the spacing, and odd rows shift half a step.
 * An approximation of the real thing — PDFium measures the glyphs the page will
 * actually carry — so treat a mismatch here as a preview bug, not a page bug.
 */
function previewPlacements(
  sheet: Box,
  tile: Box,
  config: WatermarkConfig,
): Placement[] {
  if (config.layout === "single") {
    return [{ x: sheet.width / 2, y: sheet.height / 2 }]
  }

  const stepX = tile.width + config.spacing
  const stepY = tile.height + config.spacing

  if (!(stepX > 0) || !(stepY > 0)) {
    return []
  }

  const placements: Placement[] = []
  let row = 0

  for (let y = -tile.height; y <= sheet.height + tile.height; y += stepY) {
    const offset = row % 2 === 0 ? 0 : stepX / 2

    for (
      let x = -tile.width + offset;
      x <= sheet.width + tile.width;
      x += stepX
    ) {
      if (placements.length >= MAX_PREVIEW_TILES) {
        return placements
      }

      placements.push({ x, y })
    }

    row += 1
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
  const [tile, setTile] = useState<Box>({ height: 0, width: 0 })

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
  const fontFamily = embedded
    ? "sans-serif"
    : previewFontFamily[config.fontFamily]
  const fontSize = config.fontSize * scale
  const rotation = `rotate(${config.rotation}deg)`

  // The rotated box is what the grid steps by, and a client rect already
  // accounts for the transform — so measure rather than derive it.
  useLayoutEffect(() => {
    const node = measureRef.current

    if (!node) {
      return
    }

    const rect = node.getBoundingClientRect()

    setTile({ height: rect.height, width: rect.width })
  }, [fontFamily, fontSize, rotation, text])

  const placements = previewPlacements(
    sheet,
    tile,
    { ...config, spacing: config.spacing * scale },
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
        style={{ fontFamily, fontSize: `${fontSize}px`, lineHeight: 1, transform: rotation }}
      >
        {text}
      </span>

      {placements.map((placement, index) => (
        <span
          className="pointer-events-none absolute whitespace-nowrap font-medium"
          data-testid={index === 0 ? "watermark-preview" : undefined}
          key={index}
          style={{
            color: config.color,
            fontFamily,
            fontSize: `${fontSize}px`,
            left: `${placement.x}px`,
            lineHeight: 1,
            opacity: config.opacity,
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
