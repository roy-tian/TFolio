import { rememberSettings, storedSettings } from "@/lib/settings"

/** Reads from the page's bottom-left corner towards its top-right, or back. */
export type WatermarkDirection = "ascending" | "descending"
export type WatermarkLayout = "single" | "zebra"

export type WatermarkConfig = {
  direction: WatermarkDirection
  layout: WatermarkLayout
  text: string
  /** The mark's width as a share of the page's displayed width. */
  widthRatio: number
}

export type WatermarkValidationError =
  | "empty"
  | "multiline"
  | "tooLong"
  | "style"

// Mirrored by `src-tauri/src/pdfium/watermark.rs`; both sides reject rather
// than clamp, because Tauri commands remain callable outside this UI.
export const WATERMARK_MAX_CHARS = 256
export const WATERMARK_MIN_WIDTH_RATIO = 0.1
export const WATERMARK_MAX_WIDTH_RATIO = 1

// The look the reader does not choose, mirrored from the same module so this
// preview shows the ink the page will carry.
export const WATERMARK_COLOR = "#64748b"
export const WATERMARK_OPACITY = 0.25
const WATERMARK_ZEBRA_GAP_RATIO = 1.5
export const WATERMARK_REFERENCE_FONT_SIZE = 100
const WATERMARK_MIN_FONT_SIZE = 1
const WATERMARK_MAX_FONT_SIZE = 1000

const watermarkDirections: readonly WatermarkDirection[] = [
  "ascending",
  "descending",
]
const watermarkLayouts: readonly WatermarkLayout[] = ["single", "zebra"]
const defaultWatermarkWidthRatios = {
  single: 0.8,
  zebra: 0.3,
} as const satisfies Record<WatermarkLayout, number>

export function defaultWatermarkWidthRatio(layout: WatermarkLayout): number {
  return defaultWatermarkWidthRatios[layout]
}

const defaultWatermarkSettings = {
  direction: "ascending",
  layout: "single",
  widthRatio: defaultWatermarkWidthRatio("single"),
} as const satisfies Omit<WatermarkConfig, "text">

/** `text` comes from the caller because its default is a translated one. */
export function defaultWatermarkConfig(text: string): WatermarkConfig {
  return { ...defaultWatermarkSettings, text }
}

export function isWatermarkDirection(
  value: unknown,
): value is WatermarkDirection {
  return watermarkDirections.includes(value as WatermarkDirection)
}

export function isWatermarkLayout(value: unknown): value is WatermarkLayout {
  return watermarkLayouts.includes(value as WatermarkLayout)
}

/** Mirrors `watermark_rotation` in `watermark.rs`: the mark leans along the
    page's diagonal, clockwise degrees as CSS and PDFium both read them. */
export function watermarkRotation(
  direction: WatermarkDirection,
  displayWidth: number,
  displayHeight: number,
) {
  const diagonal = (Math.atan2(displayHeight, displayWidth) * 180) / Math.PI

  return direction === "ascending" ? -diagonal : diagonal
}

/** Mirrors `watermark_font_size`: arguments share a unit, and the result
    comes back in it. */
export function watermarkFontSize(
  widthRatio: number,
  displayWidth: number,
  measuredWidth: number,
) {
  if (!(displayWidth > 0) || !(measuredWidth > 0)) {
    return 0
  }

  const size =
    (WATERMARK_REFERENCE_FONT_SIZE * widthRatio * displayWidth) / measuredWidth

  return Math.min(
    Math.max(size, WATERMARK_MIN_FONT_SIZE),
    WATERMARK_MAX_FONT_SIZE,
  )
}

export function watermarkZebraSpacing(fontSize: number) {
  return fontSize * WATERMARK_ZEBRA_GAP_RATIO
}

/**
 * `maxLength` counts UTF-16 code units, not the code points the validators
 * count; the cut also keeps a pasted novel out of the live preview.
 */
export function clampWatermarkText(text: string): string {
  const points = [...text]

  return points.length > WATERMARK_MAX_CHARS
    ? points.slice(0, WATERMARK_MAX_CHARS).join("")
    : text
}

export function validateWatermarkConfig(
  config: WatermarkConfig,
): WatermarkValidationError | null {
  const text = config.text.trim()

  if (text.length === 0) {
    return "empty"
  }
  if (/[\r\n]/.test(text)) {
    return "multiline"
  }
  if ([...text].length > WATERMARK_MAX_CHARS) {
    return "tooLong"
  }

  const usable =
    isWatermarkDirection(config.direction) &&
    isWatermarkLayout(config.layout) &&
    typeof config.widthRatio === "number" &&
    Number.isFinite(config.widthRatio) &&
    config.widthRatio >= WATERMARK_MIN_WIDTH_RATIO &&
    config.widthRatio <= WATERMARK_MAX_WIDTH_RATIO

  return usable ? null : "style"
}

export function sameWatermarkConfig(
  left: WatermarkConfig | null,
  right: WatermarkConfig | null,
) {
  if (left === null || right === null) {
    return left === right
  }

  return (
    left.text === right.text &&
    left.direction === right.direction &&
    left.layout === right.layout &&
    left.widthRatio === right.widthRatio
  )
}

/**
 * Text included, unlike the styles the annotation tools keep: the next
 * document opens on the mark this reader always applies.
 */
export function readStoredWatermarkConfig(): WatermarkConfig | null {
  const stored = storedSettings().watermark

  if (typeof stored !== "object" || stored === null) {
    return null
  }

  const config = stored as WatermarkConfig

  // The file may be older than this app or hand-edited, so a stored mark
  // earns its way back through the same check the dialog applies. Extra
  // fields older versions kept — the removed image option among them — are
  // dropped by the reconstruction below rather than rejecting the section.
  return typeof config.text === "string" &&
    validateWatermarkConfig(config) === null
    ? {
        direction: config.direction,
        layout: config.layout,
        text: config.text,
        widthRatio: config.widthRatio,
      }
    : null
}

export function storeWatermarkConfig(config: WatermarkConfig) {
  rememberSettings({ watermark: config })
}
