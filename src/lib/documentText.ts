import { invoke } from "@tauri-apps/api/core"

import { isAbortError, pageWork } from "@/lib/pageWork"

/**
 * From PDFium, not the DOM text layer: only pages near the reader carry one,
 * so a copy from the DOM would drop every page between them. Stopped by
 * `signal` between pages, which rejects with an `AbortError`.
 */
export async function documentPlainText(
  documentId: number,
  numPages: number,
  signal?: AbortSignal,
): Promise<string> {
  const pages: string[] = []

  // One page at a time, behind anything the reader is looking at: each call
  // takes the PDFium lock for its turn, and a bulk ask would fill the
  // blocking pool with tasks queued behind that lock.
  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
    const text = await pageWork
      .schedule(
        () =>
          invoke<string>("extract_pdf_page_plain_text", {
            documentId,
            pageNumber,
          }),
        { priority: () => Number.MAX_SAFE_INTEGER, signal },
      )
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          throw error
        }

        return ""
      })

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
