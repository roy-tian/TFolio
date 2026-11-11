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

/**
 * A file's pages standing together. A file let go among another's pages parts
 * it in two, and each part is a run: what the sidebar's pages head with the
 * file's name, its tree lists, and a Save As writes a bookmark for.
 */
export type FileRun = {
  count: number
  /** The run's first page, 1-based. */
  first: number
  /** The first of its file's runs, which the file's own bookmarks go beneath. */
  leads: boolean
  /** Which of its file's runs this is, counted from 0: a name for the run
      that an edit elsewhere in the document leaves alone. */
  ordinal: number
  section: number
}

export function fileRuns(pages: readonly PdfPageInfo[]): FileRun[] {
  const runs: FileRun[] = []
  const counted = new Map<number, number>()

  pages.forEach((page, index) => {
    if (page.section === undefined) {
      return
    }

    const last = runs[runs.length - 1]

    if (last && last.section === page.section && last.first + last.count === index + 1) {
      last.count += 1
      return
    }

    const ordinal = counted.get(page.section) ?? 0

    counted.set(page.section, ordinal + 1)
    runs.push({ count: 1, first: index + 1, leads: ordinal === 0, ordinal, section: page.section })
  })

  return runs
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
 * order, in front of 1-based page `before`, or to the end: a file dragged
 * among the others lands whole, gathered from every run it had. `before` may
 * be one of its own pages, which then marks the place among the others. Null
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

  if (moving.length === 0) {
    return null
  }

  const at =
    before === null
      ? staying.length
      : staying.filter((pageNumber) => pageNumber < before).length
  const order = [...staying.slice(0, at), ...moving, ...staying.slice(at)]

  return order.every((pageNumber, index) => pageNumber === index + 1) ? null : order
}
