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

/** The 1-based numbers of file `section`'s pages, wherever they stand. */
export function pagesOfSection(pages: readonly PdfPageInfo[], section: number): number[] {
  return pages.flatMap((page, index) => (page.section === section ? [index + 1] : []))
}

/** Where a paste at one end of file `section` goes, 1-based: before its first
    page, or after its last; null for a file with no page. */
export function fileEndIndex(
  pages: readonly PdfPageInfo[],
  section: number,
  end: "start" | "end",
): number | null {
  const own = pagesOfSection(pages, section)

  if (own.length === 0) {
    return null
  }

  return end === "start" ? own[0]! : own[own.length - 1]! + 1
}

/** Whether `moving` holds every page some file has: joined to another file
    where they stand, that file would be left with no page at all. */
export function emptiesItsFile(
  pages: readonly PdfPageInfo[],
  moving: readonly number[],
): boolean {
  const held = new Set(moving)

  return moving.some((pageNumber) => {
    const own = pages[pageNumber - 1]?.section

    return (
      own !== undefined &&
      pages.every((page, index) => page.section !== own || held.has(index + 1))
    )
  })
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

/**
 * The page order with every page of file `section` moved, keeping their own
 * order, in front of the first page of file `before`, or to the end: a file
 * dragged among the others lands whole, gathered from every run it had. Null
 * where nothing would move.
 */
export function fileMoveOrder(
  pages: readonly PdfPageInfo[],
  section: number,
  before: number | null,
): number[] | null {
  const moving: number[] = []
  const staying: number[] = []

  pages.forEach((page, index) => {
    if (page.section === section) {
      moving.push(index + 1)
    } else {
      staying.push(index + 1)
    }
  })

  const at =
    before === null
      ? staying.length
      : staying.findIndex((pageNumber) => pages[pageNumber - 1]?.section === before)

  if (moving.length === 0 || at < 0) {
    return null
  }

  const order = [...staying.slice(0, at), ...moving, ...staying.slice(at)]

  return order.every((pageNumber, index) => pageNumber === index + 1) ? null : order
}
