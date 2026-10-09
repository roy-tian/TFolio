import { rememberSettings, storedSettings } from "@/lib/settings"

export type PageNumbersMode = "single" | "duplex"
export type PageNumbersPosition = "bottomCenter" | "bottomRight"

export type PageNumbersConfig = {
  mode: PageNumbersMode
  position: PageNumbersPosition
  /** `null` numbers every page; otherwise a 1-based inclusive range. */
  range: [number, number] | null
  smartColor: boolean
  /** `null` prints each page's own position; otherwise the number the range's
      first page prints, counting up from there. */
  start: number | null
  blankNumbered: boolean
  /** Whether a blank page takes a number from the sequence; off forces
      `blankNumbered` off — a page that takes none has nothing to print. */
  blankCounted: boolean
}

/** What persists between documents: the style, never the document-relative
    range or start. */
export type PageNumbersPreferences = Pick<
  PageNumbersConfig,
  "mode" | "position" | "smartColor" | "blankNumbered" | "blankCounted"
>

/** `range` and `start` are text so the fields can be empty or mid-edit;
    they become a config only when applied. */
export type PageNumbersDraft = {
  mode: PageNumbersMode
  position: PageNumbersPosition
  smartColor: boolean
  blankNumbered: boolean
  blankCounted: boolean
  range: string
  start: string
}

export type PageNumbersValidationError = "range" | "start"

// Mirrored by `src-tauri/src/pdfium/page_numbers.rs`; both sides reject rather
// than clamp, because Tauri commands remain callable outside this UI.
export const PAGE_NUMBERS_FONT_SIZE = 11
export const PAGE_NUMBERS_BOTTOM_MARGIN = 51.02
export const PAGE_NUMBERS_SIDE_MARGIN = 72
export const PAGE_NUMBERS_MAX_START = 99_999

export const pageNumbersModes: readonly PageNumbersMode[] = ["single", "duplex"]
export const pageNumbersPositions: readonly PageNumbersPosition[] = [
  "bottomCenter",
  "bottomRight",
]

export const defaultPageNumbersPreferences: PageNumbersPreferences = {
  mode: "single",
  position: "bottomCenter",
  // On by default, so numbers stay legible on dark pages without the reader
  // discovering the toggle.
  smartColor: true,
  // Also on by default: numbering every page is what a reader expects, and
  // the one pair of rules the backend can honour without rendering a page.
  blankNumbered: true,
  blankCounted: true,
}

/** The same chain `page_number_face` in `font.rs` walks, so a preview is
    drawn in the font the page will carry. */
export const PAGE_NUMBERS_FONT_STACK =
  '"SimSun", "宋体", "NSimSun", "Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "Noto Serif", serif'

/** Mirrors `label` in `page_numbers.rs`, so preview and page agree. */
export function pageNumbersLabel(printed: number): string {
  return `— ${printed} —`
}

export function isMode(value: unknown): value is PageNumbersMode {
  return pageNumbersModes.includes(value as PageNumbersMode)
}

export function isPosition(value: unknown): value is PageNumbersPosition {
  return pageNumbersPositions.includes(value as PageNumbersPosition)
}

/** The backend keeps taking a mode and a position, so the `auto` pairing
    lives here rather than in either panel. */
export type PageNumbersPlacement = PageNumbersPosition | "auto"

export const pageNumbersPlacements: readonly PageNumbersPlacement[] = [
  ...pageNumbersPositions,
  "auto",
]

export function isPlacement(value: unknown): value is PageNumbersPlacement {
  return pageNumbersPlacements.includes(value as PageNumbersPlacement)
}

export function draftPlacement(draft: PageNumbersDraft): PageNumbersPlacement {
  return draft.mode === "duplex" ? "auto" : draft.position
}

/** `auto` leaves `position` untouched, so coming back from it returns the
    reader to the place they last picked rather than to the default. */
export function draftWithPlacement(
  draft: PageNumbersDraft,
  placement: PageNumbersPlacement,
): PageNumbersDraft {
  return placement === "auto"
    ? { ...draft, mode: "duplex" }
    : { ...draft, mode: "single", position: placement }
}

/** A positive integer, or null when empty or not whole — so the validator
    can tell "left blank" from "typed something unusable". */
function parseCount(value: string): number | null {
  const trimmed = value.trim()

  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return null
  }

  return Number.parseInt(trimmed, 10)
}

/** The number the range's first page would print, as far as a half-typed draft
    can say — what the preview draws on its first sheet. */
export function draftFirstPrinted(draft: PageNumbersDraft): number {
  return parseCount(draft.start) ?? parseCount(draft.range.split("-")[0] ?? "") ?? 1
}

export function isPageNumbersPreferences(
  value: unknown,
): value is PageNumbersPreferences {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const preferences = value as Record<string, unknown>

  return (
    isMode(preferences.mode) &&
    isPosition(preferences.position) &&
    typeof preferences.smartColor === "boolean" &&
    typeof preferences.blankNumbered === "boolean" &&
    typeof preferences.blankCounted === "boolean"
  )
}

export function pageNumbersPreferences(
  config: PageNumbersConfig,
): PageNumbersPreferences {
  return {
    mode: config.mode,
    position: config.position,
    smartColor: config.smartColor,
    blankNumbered: config.blankNumbered,
    blankCounted: config.blankCounted,
  }
}

/** The whole document spelled out, so a draft that covers every page opens with
    the span named rather than blank. A document of no pages has none to name. */
function wholeRange(pageCount: number): string {
  return pageCount > 0 ? `1-${pageCount}` : ""
}

/** The largest number the start field takes: the document's own length, under
    the ceiling the backend enforces. */
export function maxPageNumbersStart(pageCount: number): number {
  return Math.max(1, Math.min(pageCount, PAGE_NUMBERS_MAX_START))
}

/**
 * Blank is left blank — that is the field's own meaning, each page's own
 * position — and so is anything not a number, which the field's error names.
 */
export function clampPageNumbersStart(value: string, pageCount: number): string {
  const trimmed = value.trim()
  const parsed = Number(trimmed)

  if (trimmed === "" || !Number.isFinite(parsed)) {
    return trimmed
  }

  return String(
    Math.min(Math.max(Math.round(parsed), 1), maxPageNumbersStart(pageCount)),
  )
}

export function draftFromPreferences(
  preferences: PageNumbersPreferences,
  pageCount: number,
): PageNumbersDraft {
  return {
    mode: preferences.mode,
    position: preferences.position,
    smartColor: preferences.smartColor,
    blankNumbered: preferences.blankNumbered,
    blankCounted: preferences.blankCounted,
    range: wholeRange(pageCount),
    // The backend counts from the range's own first page when no start is
    // given, so "1" is the default it already had, now editable.
    start: "1",
  }
}

export function draftFromConfig(
  config: PageNumbersConfig,
  pageCount: number,
): PageNumbersDraft {
  return {
    mode: config.mode,
    position: config.position,
    smartColor: config.smartColor,
    blankNumbered: config.blankNumbered,
    blankCounted: config.blankCounted,
    range: config.range ? config.range.join("-") : wholeRange(pageCount),
    start: config.start === null ? "" : String(config.start),
  }
}

export function parsePageNumbersDraft(
  draft: PageNumbersDraft,
  pageCount: number,
): { config: PageNumbersConfig | null; error: PageNumbersValidationError | null } {
  const rangeText = draft.range.trim()
  let range: [number, number] | null = null

  if (rangeText !== "") {
    // Page numbering takes one contiguous span, not the arbitrary selections
    // accepted by export and split, so do not expand it with parsePageRange.
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(rangeText)
    if (!match) {
      return { config: null, error: "range" }
    }

    const from = Number(match[1])
    const to = Number(match[2] ?? match[1])
    if (from < 1 || from > to || to > pageCount) {
      return { config: null, error: "range" }
    }

    // Spelling out the whole document and leaving it blank mean the same thing.
    range = from === 1 && to === pageCount ? null : [from, to]
  }

  let start: number | null = null

  if (draft.start.trim() !== "") {
    const parsed = parseCount(draft.start)

    if (parsed === null || parsed < 1 || parsed > maxPageNumbersStart(pageCount)) {
      return { config: null, error: "start" }
    }

    start = parsed
  }

  return {
    config: {
      mode: draft.mode,
      position: draft.position,
      range,
      smartColor: draft.smartColor,
      start,
      // Also normalize older stored preferences with inconsistent flags.
      blankNumbered: draft.blankCounted && draft.blankNumbered,
      blankCounted: draft.blankCounted,
    },
    error: null,
  }
}

function sameRange(
  left: [number, number] | null,
  right: [number, number] | null,
): boolean {
  if (left === null || right === null) {
    return left === right
  }

  return left[0] === right[0] && left[1] === right[1]
}

export function samePageNumbersConfig(
  left: PageNumbersConfig | null,
  right: PageNumbersConfig | null,
): boolean {
  if (left === null || right === null) {
    return left === right
  }

  return (
    left.mode === right.mode &&
    left.position === right.position &&
    sameRange(left.range, right.range) &&
    left.smartColor === right.smartColor &&
    left.start === right.start &&
    left.blankNumbered === right.blankNumbered &&
    left.blankCounted === right.blankCounted
  )
}

/**
 * The style the reader last applied, or the defaults. Typed on the Rust
 * side and still checked here: the settings file is the reader's to edit.
 */
export function storedPageNumbersPreferences(): PageNumbersPreferences {
  const stored = storedSettings().pageNumbers

  return isPageNumbersPreferences(stored)
    ? stored
    : defaultPageNumbersPreferences
}

export function storePageNumbersPreferences(config: PageNumbersConfig) {
  rememberSettings({ pageNumbers: pageNumbersPreferences(config) })
}
