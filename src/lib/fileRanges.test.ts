import { describe, expect, it } from "bun:test"

import {
  commit,
  emptyHistory,
  inversePermutation,
  redo,
  undo,
  type AnnotationCommand,
  type AnnotationHistory,
  type DeletePagesCommand,
  type InsertBlankPageCommand,
  type MergeFileCommand,
  type ReorderPagesCommand,
} from "@/lib/annotations"
import {
  documentPageCount,
  fileCardOrderToPageOrder,
  fileRanges,
  hasMergedPages,
  nextParityOp,
  padPagePositions,
  type FileRange,
} from "@/lib/fileRanges"

function merge(name: string, pageCount: number): MergeFileCommand {
  return { insertedAt: 0, kind: "mergeFile", name, pageCount, path: `/${name}.pdf`, stashId: 0 }
}

function del(...pages: number[]): DeletePagesCommand {
  return { kind: "deletePages", pageCount: 0, pages, stashId: 0 }
}

function insert(index: number, pad = false): InsertBlankPageCommand {
  return { index, kind: "insertBlankPage", pageCount: 0, ...(pad ? { pad: true } : {}), stashId: 0 }
}

function reorder(...order: number[]): ReorderPagesCommand {
  return { inverse: inversePermutation(order), kind: "reorderPages", order }
}

function historyOf(...commands: AnnotationCommand[]): AnnotationHistory {
  return commands.reduce(commit, emptyHistory)
}

const base = { name: "base.pdf", pageCount: 2 }

/** The ranges as `[name, start, pageCount, padCount]` tuples, for terse asserts. */
function shape(ranges: FileRange[]): Array<[string, number, number, number]> {
  return ranges.map((range) => [range.name, range.start, range.pageCount, range.padAt.length])
}

describe("fileRanges", () => {
  it("reports the initial document as one range", () => {
    expect(shape(fileRanges(emptyHistory, base))).toEqual([["base.pdf", 1, 2, 0]])
  })

  it("appends a range per merge, in order", () => {
    const history = historyOf(merge("b.pdf", 3), merge("c.pdf", 1))

    expect(shape(fileRanges(history, base))).toEqual([
      ["base.pdf", 1, 2, 0],
      ["b.pdf", 3, 3, 0],
      ["c.pdf", 6, 1, 0],
    ])
  })

  it("keeps the merge's own history-entry id as the range id", () => {
    const history = historyOf(merge("b.pdf", 1))
    const [initial, merged] = fileRanges(history, base)

    expect(initial!.id).toBe(0)
    // The merge is the first (only) history entry, so its id is 1.
    expect(merged!.id).toBe(1)
  })

  it("deducts deleted pages from the range that held them", () => {
    // base [1,2] + b [3,4,5]; delete page 4 (a b page) and page 1 (a base page).
    const history = historyOf(merge("b.pdf", 3), del(1, 4))

    expect(shape(fileRanges(history, base))).toEqual([
      ["base.pdf", 1, 1, 0],
      ["b.pdf", 2, 2, 0],
    ])
  })

  it("drops a file whose every page was deleted", () => {
    const history = historyOf(merge("b.pdf", 2), del(3, 4))

    expect(shape(fileRanges(history, base))).toEqual([["base.pdf", 1, 2, 0]])
  })

  it("gives a plain inserted page to the file on its left", () => {
    // Insert before page 4 (b's second page) — joins b, as a real page.
    const history = historyOf(merge("b.pdf", 2), insert(4))

    expect(shape(fileRanges(history, base))).toEqual([
      ["base.pdf", 1, 2, 0],
      ["b.pdf", 3, 3, 0],
    ])
  })

  it("counts a pad insert as its left file's padding, not a page", () => {
    const history = historyOf(merge("b.pdf", 2), insert(3, true))

    expect(shape(fileRanges(history, base))).toEqual([
      ["base.pdf", 1, 2, 1],
      ["b.pdf", 4, 2, 0],
    ])
  })

  it("keeps a range whole when the whole file is moved", () => {
    // base [1,2] + b [3,4]; bring b to the front: order [3,4,1,2].
    const history = historyOf(merge("b.pdf", 2), reorder(3, 4, 1, 2))

    expect(shape(fileRanges(history, base))).toEqual([
      ["b.pdf", 1, 2, 0],
      ["base.pdf", 3, 2, 0],
    ])
  })

  it("re-homes a page moved across a file boundary by where it lands", () => {
    // base [1,2] + b [3,4]; move b's first page to the very front.
    const history = historyOf(merge("b.pdf", 2), reorder(3, 1, 2, 4))

    // The moved page is now its own run between two others: honest positional
    // accounting, since a page keyed by position carries no provenance.
    expect(shape(fileRanges(history, base))).toEqual([
      ["b.pdf", 1, 1, 0],
      ["base.pdf", 2, 2, 0],
      ["b.pdf", 4, 1, 0],
    ])
  })

  it("records a pad's real position when a page-level move scatters it", () => {
    // base [1,2] + b [3,4]; pad before b at 3 -> [A,A,pad,B,B]; then move base's
    // page 2 to sit after the pad -> [A,pad,A,B,B]: base's pad is now at 2, with
    // a real base page at 3. A trailing-count model would place the pad at 3 (a
    // real page) and delete that page when parity is turned off.
    const history = historyOf(merge("b.pdf", 2), insert(3, true), reorder(1, 3, 2, 4, 5))
    const [baseRange] = fileRanges(history, base)

    expect(baseRange!.padAt).toEqual([2])
    expect(shape(fileRanges(history, base))).toEqual([
      ["base.pdf", 1, 2, 1],
      ["b.pdf", 4, 2, 0],
    ])
    // Turning the feature off must name the blank at 2, not the real base page
    // at 3.
    expect(padPagePositions(history, base)).toEqual([2])
  })

  it("opens a card on its first real page when a pad leads the run", () => {
    // base [1,2] + b [3,4]; pad before b at 3 -> [A,A,pad,B,B]; then move that pad
    // to the very front -> [pad,A,A,B,B]. base's run now starts with the blank,
    // so `start` is 1 (the pad) but the card's face must be base's first real
    // page, at 2 — never the blank.
    const history = historyOf(merge("b.pdf", 2), insert(3, true), reorder(3, 1, 2, 4, 5))
    const [baseRange] = fileRanges(history, base)

    expect(baseRange!.start).toBe(1)
    expect(baseRange!.firstReal).toBe(2)
    expect(baseRange!.padAt).toEqual([1])
  })

  it("follows undo and redo through the same replay", () => {
    const merged = historyOf(merge("b.pdf", 2))
    const undone = undo(merged)!.history

    expect(shape(fileRanges(undone, base))).toEqual([["base.pdf", 1, 2, 0]])

    const redone = redo(undone)!.history

    expect(shape(fileRanges(redone, base))).toEqual([
      ["base.pdf", 1, 2, 0],
      ["b.pdf", 3, 2, 0],
    ])
  })
})

/** A hand-built range list, since parity reads only positions and counts. */
function ranges(
  ...specs: Array<{ pageCount: number; padPages?: number }>
): FileRange[] {
  let start = 1

  return specs.map((spec, index) => {
    const padCount = spec.padPages ?? 0
    const range: FileRange = {
      firstReal: start,
      id: index,
      name: `f${index}`,
      pageCount: spec.pageCount,
      // Trailing pads, the ordinary layout; the scattered case is exercised
      // through `fileRanges` replay, which records a pad's true position.
      padAt: Array.from({ length: padCount }, (_, i) => start + spec.pageCount + i),
      start,
    }

    start += spec.pageCount + padCount

    return range
  })
}

const base3 = { name: "base.pdf", pageCount: 3 }

describe("nextParityOp", () => {
  it("does nothing when every file already opens on an odd page", () => {
    // base 2, b 2: base@1-2, b@3 (odd). Nothing to do.
    expect(nextParityOp(historyOf(merge("b.pdf", 2)), base)).toBeNull()
    // A single file is always fine.
    expect(nextParityOp(emptyHistory, base)).toBeNull()
  })

  it("inserts one pad before a file that would open on an even page", () => {
    // base 3, b 2: b@4 (even) needs a pad.
    expect(nextParityOp(historyOf(merge("b.pdf", 2)), base3)).toEqual({
      kind: "insert",
      at: 4,
    })
  })

  it("is done once the needed pad is in place", () => {
    const history = historyOf(merge("b.pdf", 2), insert(4, true))

    expect(nextParityOp(history, base3)).toBeNull()
  })

  it("counts a stranded pad instead of double-planning over it", () => {
    // base 3 + b 2, pad before b, then the pad dragged between b's pages so it
    // strands (shows no card). The old range-only planner ignored it and asked
    // for pads at both 4 and 5; the slot-based op asks for exactly one, at 4.
    const history = historyOf(
      merge("b.pdf", 2),
      insert(4, true),
      reorder(1, 2, 3, 5, 4, 6),
    )

    expect(nextParityOp(history, base3)).toEqual({ kind: "insert", at: 4 })
  })

  it("removes a pad left in front of the first file", () => {
    // A pad dragged to the very front: the first file must sit at page 1.
    const history = historyOf(insert(3, true), reorder(3, 1, 2))

    expect(nextParityOp(history, base)).toEqual({ kind: "remove", at: 1 })
  })

  it("removes a blank left past the last file", () => {
    // base 2, then a trailing pad appended after it serves no file.
    const history = historyOf(insert(3, true))

    expect(nextParityOp(history, base)).toEqual({ kind: "remove", at: 3 })
  })

  it("clears a surplus pair of blanks left before an odd-starting file", () => {
    // base 2 + b 2: b naturally opens at page 3 (odd). Two blanks before it —
    // pads an earlier layout needed, then stranded together — leave b at page 5,
    // still odd, so the even-page checks pass it over. The pair is pure surplus:
    // the old range-only planner left them forever; the slot op removes them.
    const history = historyOf(merge("b.pdf", 2), insert(3, true), insert(3, true))

    // b sits at 5 (odd) with pads at 3 and 4; the first step removes one.
    expect(nextParityOp(history, base)).toEqual({ kind: "remove", at: 4 })

    // The next pass removes the other (b is even at 4 now), then it is at target
    // — b back on an odd page, both surplus blanks gone.
    const afterFirst = historyOf(merge("b.pdf", 2), insert(3, true), insert(3, true), del(4))
    expect(nextParityOp(afterFirst, base)).toEqual({ kind: "remove", at: 3 })
    const afterBoth = historyOf(merge("b.pdf", 2), insert(3, true), insert(3, true), del(4), del(3))
    expect(nextParityOp(afterBoth, base)).toBeNull()
  })

  it("keeps a lone load-bearing blank before an odd-starting file", () => {
    // base 3 + b 2: b naturally opens at page 4 (even), so its one pad (at 4) is
    // what makes it odd. That pad must never be mistaken for surplus.
    const history = historyOf(merge("b.pdf", 2), insert(4, true))

    expect(nextParityOp(history, base3)).toBeNull()
  })
})

describe("hasMergedPages", () => {
  it("is false for the initial document on its own", () => {
    expect(hasMergedPages(emptyHistory, base)).toBe(false)
    // A blank page inserted into the lone document is still not merged content.
    expect(hasMergedPages(historyOf(insert(2)), base)).toBe(false)
  })

  it("is true while a merged file keeps any of its own pages", () => {
    expect(hasMergedPages(historyOf(merge("b.pdf", 2)), base)).toBe(true)
  })

  it("is false once every merged page is gone, even if an inherited blank stays", () => {
    // base [1,2] + b [3,4]; insert a blank inside b (at 4), then delete b's two
    // original pages (3 and the shifted 5). The blank inherits b's file id — so
    // a card with a non-zero id survives — but it is this app's own page, not
    // merged content, and the backend has already cleared its merged-page set.
    const history = historyOf(merge("b.pdf", 2), insert(4), del(3, 5))

    // A range still carries b's non-zero id (the inherited blank)…
    expect(fileRanges(history, base).some((range) => range.id !== 0)).toBe(true)
    // …yet no merged page remains, so save must not stay blocked.
    expect(hasMergedPages(history, base)).toBe(false)
  })
})

describe("documentPageCount", () => {
  it("counts every page the replay leaves, pads included", () => {
    expect(documentPageCount(emptyHistory, base)).toBe(2)
    // base 2 + b 3 + one pad = 6.
    const history = historyOf(merge("b.pdf", 3), insert(3, true))

    expect(documentPageCount(history, base)).toBe(6)
  })
})

describe("padPagePositions", () => {
  it("lists every pad page's position", () => {
    // base [1,2] + pad@3 + b [4,5]; a plain insert at 6 is not a pad.
    const history = historyOf(merge("b.pdf", 2), insert(3, true), insert(6))

    expect(padPagePositions(history, base)).toEqual([3])
  })

  it("finds a pad stranded from its file by a page-level move", () => {
    // base [1,2] + pad@3 + b [4,5] = [A,A,pad,B,B]; move the pad between b's two
    // pages -> [A,A,B,pad,B]. The pad now shares its file id with neither
    // neighbour, so it forms a pad-only run that shows no card — but its blank
    // must still be found so turning parity off can remove it.
    const history = historyOf(
      merge("b.pdf", 2),
      insert(3, true),
      reorder(1, 2, 4, 3, 5),
    )

    // No card lists this pad — the ranges drop the pad-only run…
    const padWithinACard = fileRanges(history, base).flatMap((range) => range.padAt)
    expect(padWithinACard).toEqual([])
    // …but the slot-based scan still reports it, at its shifted position.
    expect(padPagePositions(history, base)).toEqual([4])
  })
})

describe("fileCardOrderToPageOrder", () => {
  it("moves each file's pages as one block", () => {
    // base [1,2] + b [3,4,5]; put b first.
    const files = ranges({ pageCount: 2 }, { pageCount: 3 })

    expect(fileCardOrderToPageOrder(files, [2, 1], 5)).toEqual([3, 4, 5, 1, 2])
  })

  it("carries a file's pad along with it", () => {
    // base [1,2] + pad [3] + b [4,5]; put b first — the pad rides with base.
    const files = ranges({ pageCount: 2, padPages: 1 }, { pageCount: 2 })

    expect(fileCardOrderToPageOrder(files, [2, 1], 5)).toEqual([4, 5, 1, 2, 3])
  })

  it("keeps a stranded page in place rather than casting it to the end", () => {
    // Page 3 belongs to no card (a pad stranded by a page-level move): the cards
    // cover 1,2 and 4,5. It rides with the card to its left (page 1,2's), not
    // the document's end.
    const files: FileRange[] = [
      { firstReal: 1, id: 0, name: "a", pageCount: 2, padAt: [], start: 1 },
      { firstReal: 4, id: 1, name: "b", pageCount: 2, padAt: [], start: 4 },
    ]

    // Reordering to the same card order must not move the stray page at all.
    expect(fileCardOrderToPageOrder(files, [1, 2], 5)).toEqual([1, 2, 3, 4, 5])
    // Bringing b to the front carries only the cards' own blocks; the stray page
    // stays welded to a's block, never named twice or dropped.
    const swapped = fileCardOrderToPageOrder(files, [2, 1], 5)
    expect([...swapped].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5])
    expect(swapped).toEqual([4, 5, 1, 2, 3])
  })
})
