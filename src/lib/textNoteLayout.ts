import { usesEmbeddedFont } from "@/lib/embeddedFont"

/** The same two faces the backend picks between, in the same order:
    Helvetica for Latin-1, the system sans past it. */
export function noteFontFamily(text: string): string {
  return usesEmbeddedFont(text) ? "sans-serif" : "Helvetica, Arial, sans-serif"
}

/** The step between a note's baselines, mirroring `TEXT_NOTE_LINE_HEIGHT` in
    `src-tauri/src/pdfium/geometry.rs`. */
export const TEXT_NOTE_LINE_HEIGHT = 1.2

/** What PDFium reports for the standard Helvetica — its own bundled clone,
    not whatever the host happens to have. */
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
 * Pinned for the standard face, whose ascent is PDFium's own; measured for
 * the embedded one, which the browser resolves as the backend's subset does.
 */
export function noteAscentRatio(text: string): number {
  return usesEmbeddedFont(text)
    ? measuredSystemAscent()
    : STANDARD_ASCENT_RATIO
}
