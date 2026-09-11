import type {
  HexColor,
  RectEffectKind,
  RectStyle,
  TextNoteStyle,
} from "@/lib/annotations"
import { rememberSettings, storedSettings } from "@/lib/settings"

/** A marker pen's colours rather than a palette's: each pale enough to read
    black text through at the opacity below. */
export const highlightSwatches: readonly HexColor[] = [
  "#ffd54a",
  "#7bed9f",
  "#7ecbff",
  "#ff9ff3",
  "#ff8a65",
]

export const defaultHighlightColor: HexColor = highlightSwatches[0]!

/** Fixed rather than offered: a highlight dark enough to hide the words under
    it has stopped being a highlight. */
export const HIGHLIGHT_OPACITY = 0.4

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
}

export function readStoredHighlightColor(): HexColor | null {
  const stored = storedSettings().annotate?.highlightColor

  return isHexColor(stored) ? stored : null
}

export function storeHighlightColor(color: HexColor) {
  rememberSettings({ annotate: { highlightColor: color } })
}

/** A mark before a cover: hues in spectrum order at one shade level, neutrals
    closing palest first. These eight are the whole choice, not a colour wheel. */
export const rectSwatches: readonly HexColor[] = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#ffffff",
  "#71717a",
  "#000000",
]

/** Slider ends, shared by the blur's sigma and the mosaic's block size. */
export const RECT_MIN_EFFECT_STRENGTH = 2
export const RECT_MAX_EFFECT_STRENGTH = 24
/** A rectangle at no opacity would be invisible, so the floor stays off zero. */
export const RECT_MIN_OPACITY = 0.1

export const rectEffectKinds: readonly RectEffectKind[] = [
  "translucent",
  "blur",
  "mosaic",
]

export function isRectEffectKind(value: unknown): value is RectEffectKind {
  return rectEffectKinds.includes(value as RectEffectKind)
}

/** A wash rather than a cover: enough to hide a face, not the whole page. */
export const defaultRectStyle: RectStyle = {
  color: rectSwatches[0]!,
  effect: "translucent",
  opacity: 0.5,
  strength: 8,
}

/** Guards a stored style the controls could not have written — tampered or an
    older schema; both numbers are checked whichever effect is stored. */
export function isRectStyle(value: unknown): value is RectStyle {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const style = value as Record<string, unknown>

  return (
    isHexColor(style.color) &&
    rectSwatches.includes(style.color) &&
    isRectEffectKind(style.effect) &&
    // The comparisons reject a non-finite number on the way (NaN fails them all).
    typeof style.opacity === "number" &&
    style.opacity >= RECT_MIN_OPACITY &&
    style.opacity <= 1 &&
    typeof style.strength === "number" &&
    style.strength >= RECT_MIN_EFFECT_STRENGTH &&
    style.strength <= RECT_MAX_EFFECT_STRENGTH
  )
}

export function readStoredRectStyle(): RectStyle | null {
  const stored = storedSettings().annotate?.rect

  return isRectStyle(stored) ? stored : null
}

export function storeRectStyle(style: RectStyle) {
  rememberSettings({ annotate: { rect: style } })
}

/** Ink a note is read as a note in, rather than mistaken for the page's text. */
export const textNoteSwatches: readonly HexColor[] = [
  "#d70015",
  "#0a84ff",
  "#1c7c3c",
  "#b25000",
  "#000000",
]

/** Mirrors `MIN_/MAX_TEXT_NOTE_*` in `src-tauri/src/pdfium/geometry.rs`:
    neither side clamps a value outside these ends. */
export const TEXT_NOTE_MIN_FONT_SIZE = 6
export const TEXT_NOTE_MAX_FONT_SIZE = 72
export const TEXT_NOTE_MIN_OPACITY = 0.1

/** Body-text size, so a note reads alongside the page rather than shouting. */
export const defaultTextNoteStyle: TextNoteStyle = {
  color: textNoteSwatches[0]!,
  fontSize: 12,
  opacity: 1,
}

/** The backend's answer when no installed face can draw a note, kept in step
    with `FONT_MISSING_ERROR` in `src-tauri/src/pdfium/font.rs`. */
export const NOTE_FONT_MISSING = "tfolio:font-missing"

export function isNoteFontMissing(error: unknown): boolean {
  return (
    error === NOTE_FONT_MISSING ||
    (error instanceof Error && error.message === NOTE_FONT_MISSING)
  )
}

/** The same guard `isRectStyle` applies: a style outside the controls' ranges
    is tampered or an older schema, and the backend would refuse it. */
export function isTextNoteStyle(value: unknown): value is TextNoteStyle {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const style = value as Record<string, unknown>

  return (
    typeof style.fontSize === "number" &&
    style.fontSize >= TEXT_NOTE_MIN_FONT_SIZE &&
    style.fontSize <= TEXT_NOTE_MAX_FONT_SIZE &&
    typeof style.opacity === "number" &&
    style.opacity >= TEXT_NOTE_MIN_OPACITY &&
    style.opacity <= 1 &&
    isHexColor(style.color)
  )
}

export function readStoredTextNoteStyle(): TextNoteStyle | null {
  const stored = storedSettings().annotate?.textNote

  return isTextNoteStyle(stored) ? stored : null
}

export function storeTextNoteStyle(style: TextNoteStyle) {
  rememberSettings({ annotate: { textNote: style } })
}
