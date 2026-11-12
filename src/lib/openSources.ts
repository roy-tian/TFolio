/** The open flow's source kinds: PDFs open as themselves, while images and
    Word documents — which a document's added files may also be — open as
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

/** The files of a drop or a launch that an open or an add can take, and the
    rest. Word documents are taken whatever this machine has: where no office
    suite is there, their conversion says so, as it does for an open. */
export function partitionOpenable(paths: string[]) {
  const openable: string[] = []
  const skipped: string[] = []

  for (const path of paths) {
    (classifyOpenSource(path) === null ? skipped : openable).push(path)
  }

  return { openable, skipped }
}

/** What a converted source's first export suggests: the same name, now a
    PDF's — "report.docx" opens with "report.pdf" waiting in Save As. */
export function pdfNameFromSource(path: string) {
  const name = path.split(/[/\\]/).pop() || path
  const dot = name.lastIndexOf(".")

  return `${dot < 0 ? name : name.slice(0, dot)}.pdf`
}
