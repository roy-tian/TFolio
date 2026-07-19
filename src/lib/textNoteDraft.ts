import type { PagePoint } from "@/lib/annotationGeometry"
import type { TextNoteCommand, TextNoteStyle } from "@/lib/annotations"

/**
 * A note being typed. It lives only in the frontend until it is committed —
 * nothing crosses the IPC boundary while the reader is still typing.
 */
export type TextNoteDraft = {
  /** The top-left of the text, in unrotated page points. */
  origin: PagePoint
  pageNumber: number
  text: string
}

/**
 * The longest note the backend will take, mirrored here so the editor stops
 * accepting characters at the point where committing would start failing rather
 * than letting a reader type a page and then refusing all of it.
 *
 * Kept in step with `MAX_TEXT_NOTE_CHARS` in `src-tauri/src/pdfium/geometry.rs`.
 */
export const TEXT_NOTE_MAX_CHARS = 4096

/** Likewise `MAX_TEXT_NOTE_LINES`. */
export const TEXT_NOTE_MAX_LINES = 256

/**
 * Whether a draft has anything worth writing. A note of only whitespace draws
 * nothing, so it is dropped rather than committed — the backend refuses it, and
 * an error for closing an editor the reader never typed in would be noise.
 */
export function isNoteWorthKeeping(text: string): boolean {
  return text.trim().length > 0
}

/**
 * Holds typed text to what the backend accepts, by characters and by lines.
 *
 * Counted in code points rather than UTF-16 units, because the backend counts
 * `chars()` — measured in units, a note of Chinese would be cut off at half the
 * length it is allowed.
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

/**
 * Whether `text` will be drawn in the bundled CJK face rather than the standard
 * font the reader picked.
 *
 * The same question `needs_embedded_font` answers in `src-tauri/src/pdfium/font.rs`
 * — can a standard PDF font encode this — and the same answer: Latin-1's
 * printable range, and nothing else. Asked here so the font-family control can
 * be disabled the moment a note leaves it, instead of letting a reader choose a
 * face the note will silently not be drawn in.
 */
export function usesEmbeddedFont(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0

    // U+0020..U+007E printable ASCII, U+00A0..U+00FF the rest of Latin-1, and
    // the two line breaks, which are structure rather than a glyph.
    return !(
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      code === 0x0a ||
      code === 0x0d
    )
  })
}

/** A draft placed where the reader clicked, ready to be typed into. */
export function startNoteDraft(
  pageNumber: number,
  origin: PagePoint,
): TextNoteDraft {
  return { origin, pageNumber, text: "" }
}

/** The command a draft becomes, or `null` if it holds nothing worth writing. */
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
