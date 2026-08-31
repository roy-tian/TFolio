import type {
  HexColor,
  RectEffectKind,
  RectStyle,
  TextNoteFontFamily,
  TextNoteStyle,
} from "@/lib/annotations"
import { readStored, store } from "@/lib/storage"

/**
 * A marker pen's colours rather than a palette's: each is pale enough to read
 * black text through at the opacity below.
 */
export const highlightSwatches: readonly HexColor[] = [
  "#ffd54a",
  "#7bed9f",
  "#7ecbff",
  "#ff9ff3",
  "#ff8a65",
]

export const defaultHighlightColor: HexColor = highlightSwatches[0]!

/**
 * Fixed rather than offered: a highlight dark enough to hide the words under it
 * has stopped being a highlight.
 */
export const HIGHLIGHT_OPACITY = 0.4

export const highlightColorStorageKey = "tfolio.annotate.highlightColor"

/** Whether `value` is a colour this app could have written. */
export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
}

export function readStoredHighlightColor(): HexColor | null {
  return readStored(highlightColorStorageKey, isHexColor)
}

export function storeHighlightColor(color: HexColor) {
  store(highlightColorStorageKey, color)
}

/**
 * A block covers what is under it, so white — the page's own ground — leads,
 * and the rest are strong enough to read as a deliberate cover rather than a
 * stain.
 */
export const rectSwatches: readonly HexColor[] = [
  "#ffffff",
  "#000000",
  "#ff3b30",
  "#0a84ff",
  "#ffcc00",
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

export const rectStyleStorageKey = "tfolio.annotate.rectStyle"

/**
 * Whether `value` is a rectangle style this app could have written. The numeric
 * ranges are part of that: the sliders never emit a non-finite size or an
 * opacity below `RECT_MIN_OPACITY`, so a stored one is tampered or from an older
 * schema, and loading it would draw an invisible mark that still records as an
 * edit. Rejected here so the caller falls back to the visible default.
 *
 * Both numbers are checked whichever effect is stored: the one the effect does
 * not use is still kept, and still becomes the mark as soon as the reader
 * switches to it.
 */
export function isRectStyle(value: unknown): value is RectStyle {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const style = value as Record<string, unknown>

  return (
    isHexColor(style.color) &&
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
  const raw = readStored(
    rectStyleStorageKey,
    (value): value is string => typeof value === "string",
  )

  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return isRectStyle(parsed) ? parsed : null
  } catch {
    // An older version may have written a shape this one no longer reads.
    return null
  }
}

export function storeRectStyle(style: RectStyle) {
  store(rectStyleStorageKey, JSON.stringify(style))
}

/** Ink a note is read as a note in, rather than mistaken for the page's text. */
export const textNoteSwatches: readonly HexColor[] = [
  "#d70015",
  "#0a84ff",
  "#1c7c3c",
  "#b25000",
  "#000000",
]

/**
 * Slider ends, and the same double-edged contract as the rectangle constants
 * above: these mirror `MIN_/MAX_TEXT_NOTE_*` in `src-tauri/src/pdfium/geometry.rs`
 * and neither side clamps a value outside them.
 */
export const TEXT_NOTE_MIN_FONT_SIZE = 6
export const TEXT_NOTE_MAX_FONT_SIZE = 72
export const TEXT_NOTE_MIN_OPACITY = 0.1

export const textNoteFontFamilies: readonly TextNoteFontFamily[] = [
  "sans",
  "serif",
  "mono",
]

/** Body-text size, so a note reads alongside the page rather than shouting. */
export const defaultTextNoteStyle: TextNoteStyle = {
  color: textNoteSwatches[0]!,
  fontFamily: "sans",
  fontSize: 12,
  opacity: 1,
}

export const textNoteStyleStorageKey = "tfolio.annotate.textNoteStyle"

export function isTextNoteFontFamily(
  value: unknown,
): value is TextNoteFontFamily {
  return textNoteFontFamilies.includes(value as TextNoteFontFamily)
}

/**
 * Whether `value` is a note style this app could have written — the same guard
 * `isRectStyle` applies, for the same reason: a stored style outside the
 * controls' ranges is tampered or from an older schema, and the backend would
 * refuse it, so a note typed against it could never be added.
 */
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
    isHexColor(style.color) &&
    isTextNoteFontFamily(style.fontFamily)
  )
}

export function readStoredTextNoteStyle(): TextNoteStyle | null {
  const raw = readStored(
    textNoteStyleStorageKey,
    (value): value is string => typeof value === "string",
  )

  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return isTextNoteStyle(parsed) ? parsed : null
  } catch {
    // An older version may have written a shape this one no longer reads.
    return null
  }
}

export function storeTextNoteStyle(style: TextNoteStyle) {
  store(textNoteStyleStorageKey, JSON.stringify(style))
}
