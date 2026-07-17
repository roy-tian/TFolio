import type { HexColor } from "@/lib/annotations"
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
