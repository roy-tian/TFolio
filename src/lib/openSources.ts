/** The open flow's source kinds: PDFs open as themselves, while images and
    Word documents — what the organize workspace also reads — open as
    converted, in-memory PDFs. */

import { isPdfPath } from "@/lib/pdf"

/** Mirrors `MERGE_IMAGE_EXTENSIONS` in `engine.rs`; this one decides what is
    offered as a source, that one what can be read. */
export const sourceImageExtensions = [
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
] as const

export function isImagePath(path: string) {
  const lowered = path.toLowerCase()

  return sourceImageExtensions.some((extension) =>
    lowered.endsWith(`.${extension}`),
  )
}

/** Mirrors `WORD_EXTENSIONS` in `src-tauri/engine/src/convert/mod.rs`. */
export const sourceWordExtensions = ["doc", "docx"] as const

export function isWordPath(path: string) {
  const lowered = path.toLowerCase()

  return sourceWordExtensions.some((extension) =>
    lowered.endsWith(`.${extension}`),
  )
}

/** Word follows the machine's own answer: where no office suite was detected,
    the extension is not a source this run can accept. */
export function isSourcePath(path: string, word = true) {
  return isPdfPath(path) || isImagePath(path) || (word && isWordPath(path))
}

export type OpenSourceKind = "pdf" | "image" | "word"

export function classifyOpenSource(path: string): OpenSourceKind | null {
  if (isPdfPath(path)) {
    return "pdf"
  }

  if (isImagePath(path)) {
    return "image"
  }

  return isWordPath(path) ? "word" : null
}

/** What a converted source's first export suggests: the same name, now a
    PDF's — "report.docx" opens with "report.pdf" waiting in Save As. */
export function pdfNameFromSource(path: string) {
  const name = path.split(/[/\\]/).pop() || path
  const dot = name.lastIndexOf(".")

  return `${dot < 0 ? name : name.slice(0, dot)}.pdf`
}
