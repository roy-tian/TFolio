import type { PagePoint } from "@/lib/annotationGeometry"
import type { TextNoteCommand, TextNoteStyle } from "@/lib/annotations"

/**
 * Lives only in the frontend until committed: nothing crosses the IPC
 * boundary while the reader is still typing.
 */
export type TextNoteDraft = {
  /** The top-left of the text, in unrotated page points. */
  origin: PagePoint
  pageNumber: number
  text: string
}

/** Mirrored from `MAX_TEXT_NOTE_CHARS` in `geometry.rs`, so the editor stops
    accepting before committing starts failing. */
export const TEXT_NOTE_MAX_CHARS = 4096

/** Likewise `MAX_TEXT_NOTE_LINES`. */
export const TEXT_NOTE_MAX_LINES = 256

/** A note of only whitespace draws nothing, so it is dropped silently —
    the backend refuses it, and an error here would be noise. */
export function isNoteWorthKeeping(text: string): boolean {
  return text.trim().length > 0
}

/**
 * Counted in code points rather than UTF-16 units, because the backend
 * counts `chars()` — units would cut a Chinese note at half its allowance.
 */
export function clampNoteText(text: string): string {
  const lines = text.split("\n")
  const withinLines =
    lines.length > TEXT_NOTE_MAX_LINES
      ? lines.slice(0, TEXT_NOTE_MAX_LINES).join("\n")
      : text
  const characters = [...withinLines]

  return characters.length > TEXT_NOTE_MAX_CHARS
    ? characters.slice(0, TEXT_NOTE_MAX_CHARS).join("")
    : withinLines
}

export function startNoteDraft(
  pageNumber: number,
  origin: PagePoint,
): TextNoteDraft {
  return { origin, pageNumber, text: "" }
}

export function noteDraftToCommand(
  draft: TextNoteDraft,
  style: TextNoteStyle,
): TextNoteCommand | null {
  if (!isNoteWorthKeeping(draft.text)) {
    return null
  }

  return {
    kind: "textNote",
    origin: draft.origin,
    pageNumber: draft.pageNumber,
    style,
    // Trailing blank lines would stretch the note's box below its last words.
    text: draft.text.replace(/\s+$/, ""),
  }
}
