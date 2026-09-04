import type { PdfSearchMatch } from "@/lib/pdf"

/** Starts at the first occurrence on or after the page being read, wrapping to
    the document's beginning when every occurrence is earlier. */
export function firstSearchMatchFromPage(
  matches: PdfSearchMatch[],
  currentPage: number,
) {
  if (matches.length === 0) {
    return null
  }

  const index = matches.findIndex((match) => match.pageNumber >= currentPage)

  return index === -1 ? 0 : index
}

/** Moves through occurrences in document order and wraps at either end. */
export function stepSearchMatch(
  current: number | null,
  count: number,
  direction: -1 | 1,
) {
  if (count <= 0) {
    return null
  }

  const index = current === null ? (direction === 1 ? -1 : 0) : current

  return (index + direction + count) % count
}
