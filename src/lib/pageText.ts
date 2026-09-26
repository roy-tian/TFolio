import type { PdfTextSpan } from "@/lib/pdf"

/** Enough for a long reading session's worth of pages; a page's runs are a
    few kilobytes, and an evicted page only costs one extraction again. */
const PAGE_TEXT_LIMIT = 200

/**
 * A page's text runs by document, page and text epoch — the epoch moves
 * whenever an edit changes what the page's text is. A page scrolled back to,
 * or remounted, would otherwise queue another extraction behind the renders.
 */
const cache = new Map<string, PdfTextSpan[]>()

function key(documentId: number, pageNumber: number, textEpoch: number) {
  return `${documentId}:${pageNumber}:${textEpoch}`
}

export function cachedPageText(
  documentId: number,
  pageNumber: number,
  textEpoch: number,
): PdfTextSpan[] | undefined {
  const at = key(documentId, pageNumber, textEpoch)
  const spans = cache.get(at)

  // Re-inserted, so the least recently read page is the one evicted.
  if (spans) {
    cache.delete(at)
    cache.set(at, spans)
  }

  return spans
}

export function rememberPageText(
  documentId: number,
  pageNumber: number,
  textEpoch: number,
  spans: PdfTextSpan[],
) {
  const at = key(documentId, pageNumber, textEpoch)

  // A `set` on a present key keeps its old place; this read is the newest.
  cache.delete(at)
  cache.set(at, spans)

  for (const oldest of cache.keys()) {
    if (cache.size <= PAGE_TEXT_LIMIT) {
      break
    }

    cache.delete(oldest)
  }
}

/** A document leaving this window takes its runs along: its epochs start
    again from zero wherever it next opens, which would match stale keys. */
export function forgetDocumentText(documentId: number) {
  const prefix = `${documentId}:`

  for (const at of cache.keys()) {
    if (at.startsWith(prefix)) {
      cache.delete(at)
    }
  }
}
