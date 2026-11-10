import type { PdfPageInfo } from "@/lib/pdf"

/** Each position's file, as the pages stand; null for a document still its
    own file alone, whose pages carry none. */
export function sectionsOf(pages: readonly PdfPageInfo[]): number[] | null {
  const sections = pages.map((page) => page.section)

  return sections.every((section) => section !== undefined) ? (sections as number[]) : null
}

/** The file pages put in front of 1-based `index` join: that page's, or at
    the very end the last page's. */
export function sectionAt(
  pages: readonly PdfPageInfo[],
  index: number,
): number | undefined {
  return (pages[index - 1] ?? pages[pages.length - 1])?.section
}

/**
 * A reorder's files, position by position, before and after it: the pages in
 * `moving` join `target`, the file they were dropped among; the rest keep
 * theirs. Undefined where the document has no files to lay out.
 */
export function reorderSections(
  pages: readonly PdfPageInfo[],
  order: readonly number[],
  moving: ReadonlySet<number>,
  target: number | undefined,
): { after: number[]; before: number[] } | undefined {
  const before = sectionsOf(pages)

  if (!before || target === undefined) {
    return undefined
  }

  return {
    after: order.map((pageNumber) =>
      moving.has(pageNumber) ? target : before[pageNumber - 1]!,
    ),
    before,
  }
}
