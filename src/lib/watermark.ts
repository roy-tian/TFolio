import type { HexColor } from "@/lib/annotations"
import { isHexColor } from "@/lib/annotationStyles"
import { readStored, store } from "@/lib/storage"
import { usesEmbeddedFont } from "@/lib/textNoteDraft"

export type WatermarkFontFamily = "sans" | "serif" | "mono"
export type WatermarkLayout = "single" | "zebra"

export type WatermarkConfig = {
  bold: boolean
  color: HexColor
  fontFamily: WatermarkFontFamily
  fontSize: number
  layout: WatermarkLayout
  opacity: number
  /** Clockwise degrees relative to the page's normal displayed direction. */
  rotation: number
  /** The gap between tiles on both axes; the grid steps by the text box plus this. */
  spacing: number
  text: string
}

export type WatermarkPreferences = Omit<WatermarkConfig, "text">

export type WatermarkValidationError =
  | "empty"
  | "multiline"
  | "tooLong"
  | "style"

// Mirrored by `src-tauri/src/pdfium/watermark.rs`; both sides reject rather
// than clamp, because Tauri commands remain callable outside this UI.
export const WATERMARK_MAX_CHARS = 256
export const WATERMARK_MIN_FONT_SIZE = 6
export const WATERMARK_MAX_FONT_SIZE = 144
export const WATERMARK_MIN_OPACITY = 0.05
export const WATERMARK_MIN_SPACING = 12
export const WATERMARK_MAX_SPACING = 240

export const watermarkFontFamilies: readonly WatermarkFontFamily[] = [
  "sans",
  "serif",
  "mono",
]
export const watermarkLayouts: readonly WatermarkLayout[] = ["single", "zebra"]

export const defaultWatermarkPreferences: WatermarkPreferences = {
  bold: false,
  color: "#64748b",
  fontFamily: "sans",
  fontSize: 36,
  layout: "single",
  opacity: 0.25,
  rotation: -30,
  spacing: 54,
}

export const watermarkPreferencesStorageKey = "tfolio.annotate.watermarkStyle"

export function defaultWatermarkConfig(
  preferences: WatermarkPreferences = defaultWatermarkPreferences,
): WatermarkConfig {
  return { ...preferences, text: "" }
}

export function watermarkUsesEmbeddedFont(text: string) {
  return usesEmbeddedFont(text)
}

export function isWatermarkFontFamily(
  value: unknown,
): value is WatermarkFontFamily {
  return watermarkFontFamilies.includes(value as WatermarkFontFamily)
}

/** The weight the preview and PDF font selected for this text can draw. */
export function watermarkFontWeightValue(
  bold: boolean,
  embedded: boolean,
) {
  // The bundled variable face uses the requested 400/800 instances. PDF's
  // standard Helvetica, Times and Courier faces expose Regular/Bold instead,
  // whose matching CSS preview weights are 400/700.
  return bold ? (embedded ? 800 : 700) : 400
}

export function isWatermarkLayout(value: unknown): value is WatermarkLayout {
  return watermarkLayouts.includes(value as WatermarkLayout)
}

function inRange(value: unknown, minimum: number, maximum: number) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  )
}

export function isWatermarkPreferences(
  value: unknown,
): value is WatermarkPreferences {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const preferences = value as Record<string, unknown>

  return (
    typeof preferences.bold === "boolean" &&
    isHexColor(preferences.color) &&
    isWatermarkFontFamily(preferences.fontFamily) &&
    inRange(
      preferences.fontSize,
      WATERMARK_MIN_FONT_SIZE,
      WATERMARK_MAX_FONT_SIZE,
    ) &&
    isWatermarkLayout(preferences.layout) &&
    inRange(preferences.opacity, WATERMARK_MIN_OPACITY, 1) &&
    typeof preferences.rotation === "number" &&
    Number.isFinite(preferences.rotation) &&
    inRange(preferences.spacing, WATERMARK_MIN_SPACING, WATERMARK_MAX_SPACING)
  )
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

  const { text: _text, ...preferences } = config

  return isWatermarkPreferences(preferences) ? null : "style"
}

/**
 * Mirrors `normalize_rotation` in `src-tauri/src/pdfium/watermark.rs`. The
 * backend canonicalises before it compares, so without the same step here the
 * two ends of the angle control — -180° and 180°, the same direction — read as
 * a change worth a history entry, and commit an undo step the page never took.
 */
export function normalizeWatermarkRotation(rotation: number) {
  if (!Number.isFinite(rotation)) {
    return rotation
  }

  const normalized = ((rotation % 360) + 360) % 360

  return normalized > 180 ? normalized - 360 : normalized
}

export function watermarkPreferences(
  config: WatermarkConfig,
): WatermarkPreferences {
  const { text: _text, ...preferences } = config

  return preferences
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
    left.bold === right.bold &&
    left.fontFamily === right.fontFamily &&
    left.fontSize === right.fontSize &&
    left.color === right.color &&
    left.opacity === right.opacity &&
    left.rotation === right.rotation &&
    left.layout === right.layout &&
    left.spacing === right.spacing
  )
}

export function readStoredWatermarkPreferences(): WatermarkPreferences | null {
  const raw = readStored(
    watermarkPreferencesStorageKey,
    (value): value is string => typeof value === "string",
  )

  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    // Styles saved before weight selection existed implicitly used Regular.
    // Keep the rest of that reader's preferences instead of dropping the
    // entire record when upgrading.
    const migrated =
      typeof parsed === "object" &&
      parsed !== null &&
      !("bold" in parsed)
        ? { ...parsed, bold: false }
        : parsed

    return isWatermarkPreferences(migrated) ? migrated : null
  } catch {
    return null
  }
}

export function storeWatermarkPreferences(config: WatermarkConfig) {
  store(watermarkPreferencesStorageKey, JSON.stringify(watermarkPreferences(config)))
}
