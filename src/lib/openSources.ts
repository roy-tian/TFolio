/** The open flow's source kinds: PDFs open as themselves, while images and
    Word documents — the merge wizard's source lists — open as converted,
    in-memory PDFs. */

import { isMergeImagePath, isMergeWordPath } from "@/lib/mergeWizard"
import { isPdfPath } from "@/lib/pdf"

export type OpenSourceKind = "pdf" | "image" | "word"

export function classifyOpenSource(path: string): OpenSourceKind | null {
  if (isPdfPath(path)) {
    return "pdf"
  }

  if (isMergeImagePath(path)) {
    return "image"
  }

  return isMergeWordPath(path) ? "word" : null
}

/** What a converted source's first export suggests: the same name, now a
    PDF's — "report.docx" opens with "report.pdf" waiting in Save As. */
export function pdfNameFromSource(path: string) {
  const name = path.split(/[/\\]/).pop() || path
  const dot = name.lastIndexOf(".")

  return `${dot < 0 ? name : name.slice(0, dot)}.pdf`
}
