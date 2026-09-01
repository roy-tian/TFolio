import { readStored, store } from "@/lib/storage"
import { usesEmbeddedFont } from "@/lib/textNoteDraft"

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

const defaultWatermarkSettings = {
  direction: "ascending",
  layout: "single",
  widthRatio: 0.8,
} as const satisfies Omit<WatermarkConfig, "text">

export const watermarkStorageKey = "tfolio.watermark.settings"

/** `text` comes from the caller because its default is a translated one. */
export function defaultWatermarkConfig(text: string): WatermarkConfig {
  return { ...defaultWatermarkSettings, text }
}

export function watermarkUsesEmbeddedFont(text: string) {
  return usesEmbeddedFont(text)
}

export function isWatermarkDirection(
  value: unknown,
): value is WatermarkDirection {
  return watermarkDirections.includes(value as WatermarkDirection)
}

export function isWatermarkLayout(value: unknown): value is WatermarkLayout {
  return watermarkLayouts.includes(value as WatermarkLayout)
}

/**
 * Mirrors `watermark_rotation` in `src-tauri/src/pdfium/watermark.rs`: the mark
 * leans along the page's own diagonal, so a full-width one runs corner to
 * corner whatever proportions the sheet has. Clockwise degrees, as CSS and
 * PDFium both read them.
 */
export function watermarkRotation(
  direction: WatermarkDirection,
  displayWidth: number,
  displayHeight: number,
) {
  const diagonal = (Math.atan2(displayHeight, displayWidth) * 180) / Math.PI

  return direction === "ascending" ? -diagonal : diagonal
}

/**
 * Mirrors `watermark_font_size`: the size at which the mark covers its share of
 * the page width, from the same mark measured at `WATERMARK_REFERENCE_FONT_SIZE`.
 * Both arguments must be in the same unit, and the result comes back in it.
 */
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
 * Cuts `text` to the unit the validator and `MAX_WATERMARK_CHARS` in
 * `watermark.rs` both count in: Unicode code points. The field cannot use
 * `maxLength` for this — that counts UTF-16 code units, which stops a watermark
 * of emoji or other astral characters at half the allowance the two validators
 * grant. Keeping the cut here rather than dropping the cap entirely also keeps
 * a pasted novel out of the live preview.
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
 * The reader's last applied watermark, text included — unlike the styles the
 * annotation tools keep, this one is the whole setting, so the next document
 * opens on the mark this reader always applies rather than an empty field.
 */
export function readStoredWatermarkConfig(): WatermarkConfig | null {
  const raw = readStored(
    watermarkStorageKey,
    (value): value is string => typeof value === "string",
  )

  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (typeof parsed !== "object" || parsed === null) {
      return null
    }

    const config = parsed as WatermarkConfig

    // What is in storage may come from an older version of the app, or a reader
    // with a console open, so it earns its way back in through the same check
    // the dialog applies.
    return typeof config.text === "string" &&
      validateWatermarkConfig(config) === null
      ? {
          direction: config.direction,
          layout: config.layout,
          text: config.text,
          widthRatio: config.widthRatio,
        }
      : null
  } catch {
    return null
  }
}

export function storeWatermarkConfig(config: WatermarkConfig) {
  store(watermarkStorageKey, JSON.stringify(config))
}
