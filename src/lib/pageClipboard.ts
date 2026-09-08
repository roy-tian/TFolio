import { isIdentityOrder } from "@/lib/annotations"
import { orderAfterMove } from "@/lib/pageDrag"

/**
 * The pages the reader took out of the thumbnail grid, and what a paste is to
 * do with them: a cut moves them, a copy leaves them where they are.
 *
 * Page numbers rather than pages, so — like the grid's selection — the whole
 * thing stops meaning anything the moment the document's pages move. Only the
 * paste's own insert is exempt, and only because it says exactly how far each
 * page slid (see `clipboardAfterPaste`).
 */
export type PageClipboard = {
  mode: "cut" | "copy"
  /** Ascending 1-based page numbers, deduplicated. */
  pages: number[]
}

/** What the reader took, however their clicks arrived at it. An empty
    selection takes nothing: there is no such thing as an empty clipboard. */
export function pageClipboardOf(
  mode: PageClipboard["mode"],
  pages: Iterable<number>,
): PageClipboard | null {
  const sorted = [...new Set(pages)].sort((left, right) => left - right)

  return sorted.length === 0 ? null : { mode, pages: sorted }
}

/**
 * What a paste at 1-based `index` comes to: a cut is a move, which the reorder
 * command already knows how to make one undo step of, and a copy is the
 * document taking its own pages in again.
 */
export type PastePlan =
  | { kind: "move"; order: number[]; pages: number[] }
  | { kind: "copy"; pages: number[] }

/**
 * The plan for pasting into the gap before `index`, or null where there is
 * nothing to do: no clipboard, a position or a page the document does not have
 * — both read off a grid that may have been renumbered since — or a move that
 * would put every page back where it already is.
 */
export function pastePlan(
  clipboard: PageClipboard | null,
  index: number,
  pageCount: number,
): PastePlan | null {
  if (
    !clipboard ||
    index < 1 ||
    index > pageCount + 1 ||
    clipboard.pages.some((pageNumber) => pageNumber > pageCount)
  ) {
    return null
  }

  if (clipboard.mode === "copy") {
    return { kind: "copy", pages: clipboard.pages }
  }

  // The gap counts the positions between the pages as they stand, so the gap
  // before page `index` is the one numbered one lower.
  const order = orderAfterMove(clipboard.pages, index - 1, pageCount)

  return isIdentityOrder(order)
    ? null
    : { kind: "move", order, pages: clipboard.pages }
}

/**
 * The clipboard a paste of its own pages leaves behind: a cut is spent, and a
 * copy goes on naming the pages it named — which the `count` copies landing at
 * `index` have pushed down, wherever they landed at or before them.
 */
export function clipboardAfterPaste(
  clipboard: PageClipboard | null,
  index: number,
  count: number,
): PageClipboard | null {
  if (!clipboard || clipboard.mode === "cut") {
    return null
  }

  return {
    mode: "copy",
    pages: clipboard.pages.map((pageNumber) =>
      pageNumber >= index ? pageNumber + count : pageNumber,
    ),
  }
}

/** How many runs a notice names before it gives up and says "and more". A
    scattered selection would otherwise run the toast down the screen. */
const MAX_LISTED_RUNS = 6

/**
 * Page numbers as a reader would write them: consecutive ones close up into a
 * run, so `[1, 2, 3, 5]` reads "1–3, 5". Numbers only — the surrounding words,
 * and the page count beside them, belong to the translated string.
 */
export function formatPageRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((left, right) => left - right)
  const runs: string[] = []
  let start: number | null = null
  let end = 0

  const close = () => {
    if (start !== null) {
      runs.push(start === end ? `${start}` : `${start}–${end}`)
    }
  }

  for (const pageNumber of sorted) {
    if (start !== null && pageNumber === end + 1) {
      end = pageNumber
      continue
    }

    close()
    start = pageNumber
    end = pageNumber
  }

  close()

  return runs.length > MAX_LISTED_RUNS
    ? `${runs.slice(0, MAX_LISTED_RUNS).join(", ")}…`
    : runs.join(", ")
}
