import { isIdentityOrder } from "@/lib/annotations"
import { orderAfterMove } from "@/lib/pageDrag"

/**
 * Page numbers, not pages, so this stops meaning anything the moment the
 * document's pages move — only the paste's own insert (`clipboardAfterPaste`).
 */
export type PageClipboard = {
  mode: "cut" | "copy"
  /** Ascending 1-based page numbers, deduplicated. */
  pages: number[]
}

/** An empty selection takes nothing: there is no such thing as an empty
    clipboard. */
export function pageClipboardOf(
  mode: PageClipboard["mode"],
  pages: Iterable<number>,
): PageClipboard | null {
  const sorted = [...new Set(pages)].sort((left, right) => left - right)

  return sorted.length === 0 ? null : { mode, pages: sorted }
}

/**
 * The window's one page clipboard: the pages last cut or copied in any of its
 * documents, by the document they stand in. Page numbers still, so that
 * document lets go of them as soon as its pages move. One store, of which a
 * document reads its own half: what it holds itself, or what another holds
 * for it to paste. A window is its own WebView, so the module's state is the
 * window's.
 */
export type HeldPages = PageClipboard & { sourceDocumentId: number }

/** What a document answers for the pages it holds: only it can say whether
    they still stand as numbered, or take them out. */
export type PageSource = {
  /** No structure edit in flight: the numbers still name the pages. */
  idle: () => boolean
  /** The document's name, for another to say which is busy. */
  name: () => string
  /** Another document's cut or copy replaced what this one held. */
  superseded: (held: HeldPages) => void
  /** A cut pasted into another document: its pages leave this one. */
  takeOut: (pages: number[]) => void
}

let held: HeldPages | null = null
const heldListeners = new Set<() => void>()
const pageSources = new Map<number, PageSource>()

function setHeld(next: HeldPages | null) {
  if (next === held) {
    return
  }

  held = next

  for (const listener of [...heldListeners]) {
    listener()
  }
}

export function heldPages(): HeldPages | null {
  return held
}

/** Takes the clipboard, over whatever any document held. */
export function holdPages(next: HeldPages) {
  const last = held

  setHeld(next)

  if (last && last.sourceDocumentId !== next.sourceDocumentId) {
    pageSources.get(last.sourceDocumentId)?.superseded(last)
  }
}

/** A document letting go of what it holds, unless another has taken since. */
export function letGoOfPages(sourceDocumentId: number) {
  if (held?.sourceDocumentId === sourceDocumentId) {
    setHeld(null)
  }
}

export function subscribeHeldPages(listener: () => void) {
  heldListeners.add(listener)

  return () => {
    heldListeners.delete(listener)
  }
}

/** A document whose pages can be held, until the returned call: a tab closed
    with pages on the clipboard takes them with it. */
export function registerPageSource(documentId: number, source: PageSource) {
  pageSources.set(documentId, source)

  return () => {
    // Registered again since, the document and its pages are another's to answer for.
    if (pageSources.get(documentId) === source) {
      pageSources.delete(documentId)
      letGoOfPages(documentId)
    }
  }
}

/** The document `pages` stand in, for whoever is about to read them by
    their numbers. */
export function pageSourceOf(pages: HeldPages): PageSource | undefined {
  return pageSources.get(pages.sourceDocumentId)
}

/** A cut pasted into another document leaves the one it was made in — once,
    and only while it is still what the window holds: a second paste, or one
    landing after an edit there let go of it, would take out whatever pages
    then hold those numbers. */
export function movePagesOut(pages: HeldPages) {
  if (held !== pages) {
    return
  }

  setHeld(null)
  pageSources.get(pages.sourceDocumentId)?.takeOut(pages.pages)
}

/** A cut is a move, which the reorder command already makes one undo step
    of; a copy is the document taking its own pages in again. */
export type PastePlan =
  | { kind: "move"; order: number[]; pages: number[] }
  | { kind: "copy"; pages: number[] }

/** Null where there is nothing to do: a position or page the document does
    not have — read off a grid renumbered since — or a move that changes nothing. */
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

/** A cut is spent; a copy goes on naming the pages it named, which the
    `count` copies landing at `index` have pushed down. */
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

/** Numbers only — the surrounding words, and the page count beside them,
    belong to the translated string. */
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
