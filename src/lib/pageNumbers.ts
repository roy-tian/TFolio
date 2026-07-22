import { readStored, store } from "@/lib/storage"

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
}

/** What persists between documents: the style, never the document-relative
    range or start. */
export type PageNumbersPreferences = Pick<
  PageNumbersConfig,
  "mode" | "position" | "smartColor"
>

/**
 * The dialog's editable form. `range` and `start` are text so the fields can be
 * empty or mid-edit; they become a config only when applied.
 */
export type PageNumbersDraft = {
  mode: PageNumbersMode
  position: PageNumbersPosition
  smartColor: boolean
  allPages: boolean
  rangeFrom: string
  rangeTo: string
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
}

export const pageNumbersPreferencesStorageKey = "tfolio.annotate.pageNumbersStyle"

/** The label a page prints, mirroring `label` in `page_numbers.rs`: an em dash
    and a space on each side. */
export function pageNumbersLabel(printed: number): string {
  return `— ${printed} —`
}

export function isMode(value: unknown): value is PageNumbersMode {
  return pageNumbersModes.includes(value as PageNumbersMode)
}

export function isPosition(value: unknown): value is PageNumbersPosition {
  return pageNumbersPositions.includes(value as PageNumbersPosition)
}

/** Parses a field the reader typed into a positive integer, or null when it is
    empty, blank, or not a whole number — so the validator can tell "left blank"
    from "typed something unusable". */
function parseCount(value: string): number | null {
  const trimmed = value.trim()

  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return null
  }

  return Number.parseInt(trimmed, 10)
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
    typeof preferences.smartColor === "boolean"
  )
}

export function pageNumbersPreferences(
  config: PageNumbersConfig,
): PageNumbersPreferences {
  return {
    mode: config.mode,
    position: config.position,
    smartColor: config.smartColor,
  }
}

export function draftFromPreferences(
  preferences: PageNumbersPreferences,
): PageNumbersDraft {
  return {
    mode: preferences.mode,
    position: preferences.position,
    smartColor: preferences.smartColor,
    allPages: true,
    rangeFrom: "",
    rangeTo: "",
    start: "",
  }
}

export function draftFromConfig(config: PageNumbersConfig): PageNumbersDraft {
  return {
    mode: config.mode,
    position: config.position,
    smartColor: config.smartColor,
    allPages: config.range === null,
    rangeFrom: config.range ? String(config.range[0]) : "",
    rangeTo: config.range ? String(config.range[1]) : "",
    start: config.start === null ? "" : String(config.start),
  }
}

/**
 * Turns a draft into a config, or names the field that stops it. The range is
 * checked against the document's length; a blank start prints document
 * positions, and a filled one must be a whole number within range.
 */
export function parsePageNumbersDraft(
  draft: PageNumbersDraft,
  pageCount: number,
): { config: PageNumbersConfig | null; error: PageNumbersValidationError | null } {
  let range: [number, number] | null = null

  if (!draft.allPages) {
    const from = parseCount(draft.rangeFrom)
    const to = parseCount(draft.rangeTo)

    if (from === null || to === null || from < 1 || from > to || to > pageCount) {
      return { config: null, error: "range" }
    }

    range = [from, to]
  }

  let start: number | null = null

  if (draft.start.trim() !== "") {
    const parsed = parseCount(draft.start)

    if (parsed === null || parsed < 1 || parsed > PAGE_NUMBERS_MAX_START) {
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
    left.start === right.start
  )
}

export function readStoredPageNumbersPreferences(): PageNumbersPreferences | null {
  const raw = readStored(
    pageNumbersPreferencesStorageKey,
    (value): value is string => typeof value === "string",
  )

  if (raw === null) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return isPageNumbersPreferences(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function storePageNumbersPreferences(config: PageNumbersConfig) {
  store(
    pageNumbersPreferencesStorageKey,
    JSON.stringify(pageNumbersPreferences(config)),
  )
}
