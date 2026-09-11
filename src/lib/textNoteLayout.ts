import { usesEmbeddedFont } from "@/lib/embeddedFont"

/**
 * The face a note is drawn in, as closely as CSS can say it: Helvetica for the
 * Latin-1 the standard fonts cover, and the system's own sans for everything
 * past it — the same two the backend picks between, in the same order.
 */
export function noteFontFamily(text: string): string {
  return usesEmbeddedFont(text) ? "sans-serif" : "Helvetica, Arial, sans-serif"
}

/** The step between a note's baselines, mirroring `TEXT_NOTE_LINE_HEIGHT` in
    `src-tauri/src/pdfium/geometry.rs`. */
export const TEXT_NOTE_LINE_HEIGHT = 1.2

/** What PDFium reports for the standard Helvetica, which is its own bundled
    clone — not whatever Helvetica or Arial the host happens to have. */
const STANDARD_ASCENT_RATIO = 0.945

/** Large enough that the metric's own rounding cannot reach the ratio. */
const ASCENT_REFERENCE_SIZE = 100

/** Stands in where a WebView reports no font metrics at all: between the ~0.96
    of the usual system sans and the 1.16 of the bundled fallback. */
const FALLBACK_ASCENT_RATIO = 1

let systemAscent: number | null = null

function measuredSystemAscent(): number {
  if (systemAscent !== null) {
    return systemAscent
  }

  const context = document.createElement("canvas").getContext("2d")

  if (context) {
    context.font = `${ASCENT_REFERENCE_SIZE}px sans-serif`

    const ascent = context.measureText("H").fontBoundingBoxAscent

    if (Number.isFinite(ascent) && ascent > 0) {
      systemAscent = ascent / ASCENT_REFERENCE_SIZE

      return systemAscent
    }
  }

  systemAscent = FALLBACK_ASCENT_RATIO

  return systemAscent
}

/**
 * How far below a note's origin its first baseline sits, as a fraction of the
 * font size: `add_text_note` puts each baseline the face's own ascent below the
 * point that was clicked, and faces differ by a fifth of a line.
 *
 * Pinned for the standard face, whose ascent is PDFium's own wherever the note
 * is read; measured for the embedded one, because `embedded_face_subset` takes
 * the system's face ahead of the bundled fallback, and so does the browser. A
 * host whose default sans cannot draw the note is the case the two can differ
 * on, and the one where the preview's glyphs would already be substitutes.
 */
export function noteAscentRatio(text: string): number {
  return usesEmbeddedFont(text)
    ? measuredSystemAscent()
    : STANDARD_ASCENT_RATIO
}
