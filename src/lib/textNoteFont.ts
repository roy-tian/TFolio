import { invoke } from "@tauri-apps/api/core"

import { usesEmbeddedFont } from "@/lib/embeddedFont"

export type TextNoteFont = {
  family: string
  ascent: number
  dispose: () => void
}

let nextFont = 0

/** A note owns its small subset until its PDF pixels replace the preview.
    FontFace accepts bytes directly, so no URL or CSP exception is needed. */
export async function prepareTextNoteFont(text: string): Promise<TextNoteFont | null> {
  if (!usesEmbeddedFont(text)) return null

  const packet = await invoke<ArrayBuffer>("pdf_text_note_font", { text })
  if (packet.byteLength <= 4) throw new Error("The note font is missing")
  const ascent = new DataView(packet).getFloat32(0, true)
  if (!Number.isFinite(ascent) || ascent <= 0) throw new Error("Invalid note font ascent")

  const family = `TFolioNote${++nextFont}`
  const face = await new FontFace(family, packet.slice(4)).load()
  document.fonts.add(face)

  return { family, ascent, dispose: () => { document.fonts.delete(face) } }
}
