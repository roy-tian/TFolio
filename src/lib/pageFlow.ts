import type { PdfPageInfo } from "@/lib/pdf"

/** What the sidebar's pages lay out, in the order shown. `index` is the
    place in that order of the page, or of the first page under a bar. */
export type FlowItem =
  | {
      /** The file whose name stands before this page: the first of a run. */
      heads?: number
      index: number
      kind: "page"
      pageNumber: number
    }
  | {
      /** Every page under the bar is in hand. */
      held: boolean
      index: number
      kind: "bar"
      pages: number[]
      section: number
    }

/**
 * The pages as their flow shows them: each a cell, a file's name before the
 * first of its run, and a folded file's run as one bar under its name. Pages
 * in hand stand under the name of the file a release would leave them in,
 * `joins` or else their own: between two files, the name over the place
 * they would land says which. Folded ones in hand are a bar of their own. A
 * bar ends where `breakAt`, a place in `order`, falls: what lands there
 * stands in front of it, never inside.
 */
export function flowItems({
  breakAt,
  byFile,
  folded,
  held,
  joins,
  order,
  pages,
}: {
  breakAt: number | null
  /** Whether each file's name heads its pages: only then can one be folded. */
  byFile: boolean
  folded: ReadonlySet<number>
  held: ReadonlySet<number>
  /** The file the pages in hand join, let go where they stand; absent, each
      keeps its own. */
  joins?: number
  order: readonly number[]
  pages: readonly PdfPageInfo[]
}): FlowItem[] {
  const items: FlowItem[] = []
  let headed: number | undefined
  let bar: Extract<FlowItem, { kind: "bar" }> | null = null

  order.forEach((pageNumber, index) => {
    const own = pages[pageNumber - 1]?.section
    const inHand = held.has(pageNumber)

    if (byFile && own !== undefined && folded.has(own)) {
      if (bar && bar.section === own && bar.held === inHand && index !== breakAt) {
        bar.pages.push(pageNumber)
        return
      }

      bar = { held: inHand, index, kind: "bar", pages: [pageNumber], section: own }
      items.push(bar)

      if (!inHand) {
        headed = own
      }

      return
    }

    bar = null

    const section = inHand && joins !== undefined ? joins : own
    // A folded file's name is its bar: a page joining it stands beside that.
    const heads =
      byFile && section !== undefined && section !== headed && !folded.has(section)
        ? section
        : undefined

    if (heads !== undefined) {
      headed = heads
    }

    items.push({ heads, index, kind: "page", pageNumber })
  })

  return items
}
