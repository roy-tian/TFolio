/**
 * Mirrors `needs_embedded_font` in `src-tauri/src/pdfium/font.rs` — Latin-1's
 * printable range, nothing else — so a preview matches the embedded metrics.
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
