import { invoke } from "@tauri-apps/api/core"

/**
 * The whole document's text, in page order, as a select-all hands it to the
 * clipboard. It comes from PDFium rather than from the text layer on screen:
 * only the pages near the reader carry one, so a copy taken from the DOM would
 * quietly drop every page between them.
 */
export async function documentPlainText(
  documentId: number,
  numPages: number,
): Promise<string> {
  const pages: string[] = []

  // One page at a time. Each call takes the PDFium lock for its own turn, and
  // asking for a long document's pages at once would fill the blocking pool
  // with tasks queued behind that lock.
  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
    const text = await invoke<string>("extract_pdf_page_plain_text", {
      documentId,
      pageNumber,
    }).catch(() => "")

    const page = normalizeLineEndings(text).trim()

    if (page !== "") {
      pages.push(page)
    }
  }

  return pages.join("\n\n")
}

/** PDFium reports CRLF; the clipboard is handed the one line ending. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}
