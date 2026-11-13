import { describe, expect, it } from "bun:test"

import {
  clipboardAfterPaste,
  formatPageRanges,
  pageClipboardOf,
  pastePlan,
  heldPages,
  holdPages,
  letGoOfPages,
  movePagesOut,
  pageSourceOf,
  pagesStanding,
  registerPageSource,
  subscribeHeldPages,
} from "@/lib/pageClipboard"

describe("pageClipboardOf", () => {
  it("sorts and deduplicates whatever the clicks arrived at", () => {
    expect(pageClipboardOf("cut", [5, 2, 5])).toEqual({
      mode: "cut",
      pages: [2, 5],
    })
  })

  it("takes nothing from an empty selection", () => {
    expect(pageClipboardOf("copy", [])).toBeNull()
  })
})

describe("pastePlan", () => {
  it("moves a cut block into the gap, keeping its own order", () => {
    const plan = pastePlan(pageClipboardOf("cut", [1, 2]), 4, 4)

    expect(plan).toEqual({ kind: "move", order: [3, 1, 2, 4], pages: [1, 2] })
  })

  it("moves a cut block to the end", () => {
    const plan = pastePlan(pageClipboardOf("cut", [1]), 4, 3)

    expect(plan).toEqual({ kind: "move", order: [2, 3, 1], pages: [1] })
  })

  it("has nothing to do for a move that changes nothing", () => {
    expect(pastePlan(pageClipboardOf("cut", [2, 3]), 2, 4)).toBeNull()
  })

  it("copies the block wherever it goes, itself included", () => {
    const plan = pastePlan(pageClipboardOf("copy", [2]), 2, 3)

    expect(plan).toEqual({ kind: "copy", pages: [2] })
  })

  it("refuses positions and pages the document does not have", () => {
    const clipboard = pageClipboardOf("copy", [2])

    expect(pastePlan(clipboard, 0, 3)).toBeNull()
    expect(pastePlan(clipboard, 5, 3)).toBeNull()
    // The grid the pages were taken off has been renumbered since.
    expect(pastePlan(pageClipboardOf("copy", [4]), 1, 3)).toBeNull()
    expect(pastePlan(null, 1, 3)).toBeNull()
  })

  it("takes the position one past the last page", () => {
    expect(pastePlan(pageClipboardOf("copy", [1]), 4, 3)).not.toBeNull()
  })
})

describe("clipboardAfterPaste", () => {
  it("spends a cut", () => {
    expect(clipboardAfterPaste(pageClipboardOf("cut", [1]), 3, 1)).toBeNull()
  })

  it("follows the copied pages the insert pushed down", () => {
    const clipboard = pageClipboardOf("copy", [1, 4])

    expect(clipboardAfterPaste(clipboard, 3, 2)).toEqual({
      mode: "copy",
      pages: [1, 6],
    })
  })

  it("pushes a page down when the copies land on its own position", () => {
    expect(clipboardAfterPaste(pageClipboardOf("copy", [2]), 2, 1)).toEqual({
      mode: "copy",
      pages: [3],
    })
  })
})

describe("formatPageRanges", () => {
  it("closes consecutive pages into runs", () => {
    expect(formatPageRanges([1, 2, 3, 5])).toBe("1–3, 5")
    expect(formatPageRanges([4])).toBe("4")
    expect(formatPageRanges([])).toBe("")
  })

  it("sorts and deduplicates before reading the runs off", () => {
    expect(formatPageRanges([3, 1, 2, 2])).toBe("1–3")
  })

  it("gives up on a selection too scattered to name", () => {
    expect(formatPageRanges([1, 3, 5, 7, 9, 11, 13, 15])).toBe(
      "1, 3, 5, 7, 9, 11…",
    )
  })
})

describe("the window's held pages", () => {
  const taken = (sourceDocumentId: number, mode: "cut" | "copy" = "copy") => ({
    mode,
    pages: [2, 3],
    sourceDocumentId,
  })
  const source = (log: string[], name: string, state = { busy: false, edits: 0, keeps: false }) => ({
    edits: () => state.edits,
    idle: () => !state.busy,
    name: () => name,
    superseded: () => log.push(`${name} superseded`),
    takeOut: (pages: number[]) => {
      log.push(`${name} takes out ${pages.join()}`)
      return !state.keeps
    },
  })
  const copied = Promise.resolve(true)

  it("holds the last pages any document took, and says when they change", () => {
    let told = 0
    const stop = subscribeHeldPages(() => {
      told += 1
    })

    holdPages(taken(1))
    expect(heldPages()?.sourceDocumentId).toBe(1)
    holdPages(taken(2))
    expect(heldPages()?.sourceDocumentId).toBe(2)
    expect(told).toBe(2)

    stop()
    letGoOfPages(2)
    expect(told).toBe(2)
    expect(heldPages()).toBeNull()
  })

  it("lets a document let go only of what is still its own", () => {
    holdPages(taken(1))
    holdPages(taken(2))

    letGoOfPages(1)
    expect(heldPages()?.sourceDocumentId).toBe(2)
    letGoOfPages(2)
    expect(heldPages()).toBeNull()
  })

  it("tells the document whose pages another's take replaced, not one taking again", () => {
    const log: string[] = []
    const stop = [registerPageSource(1, source(log, "one")), registerPageSource(2, source(log, "two"))]

    holdPages(taken(1, "cut"))
    holdPages(taken(1))
    expect(log).toEqual([])
    holdPages(taken(2))
    expect(log).toEqual(["one superseded"])

    stop.forEach((unregister) => unregister())
  })

  it("moves a cut out of its document once, and only while it is still held", () => {
    const log: string[] = []
    const unregister = registerPageSource(1, source(log, "one"))
    const cut = taken(1, "cut")

    holdPages(cut)
    expect(pageSourceOf(cut)?.name()).toBe("one")
    expect(movePagesOut(cut, copied)).toBe(true)
    expect(movePagesOut(cut, copied)).toBe(false)
    expect(log).toEqual(["one takes out 2,3"])
    expect(heldPages()).toBeNull()

    // Let go by an edit before the paste was made: nothing is taken out.
    const stale = taken(1, "cut")

    holdPages(stale)
    letGoOfPages(1)
    expect(movePagesOut(stale, copied)).toBe(false)
    expect(log).toEqual(["one takes out 2,3"])

    unregister()
  })

  it("spends a cut its document keeps, and says the pages stay", () => {
    const unregister = registerPageSource(1, source([], "one", { busy: false, edits: 0, keeps: true }))
    const cut = taken(1, "cut")

    holdPages(cut)
    expect(movePagesOut(cut, copied)).toBe(false)
    expect(heldPages()).toBeNull()

    unregister()
  })

  it("stands until an edit lands in the pages' document, and not while one is under way", () => {
    const state = { busy: false, edits: 0, keeps: false }
    const unregister = registerPageSource(1, source([], "one", state))
    const stands = pagesStanding(1)

    expect(stands()).toBe(true)
    state.busy = true
    expect(stands()).toBe(false)
    // An edit that never landed moved nothing.
    state.busy = false
    expect(stands()).toBe(true)
    state.edits += 1
    expect(stands()).toBe(false)
    // Taken under the new count, the numbers stand again.
    expect(pagesStanding(1)()).toBe(true)

    unregister()
  })

  it("never stands for a document closed, or opened again, since", () => {
    const first = registerPageSource(1, source([], "one"))
    const stands = pagesStanding(1)

    first()
    expect(stands()).toBe(false)

    const again = registerPageSource(1, source([], "one"))

    expect(stands()).toBe(false)
    expect(pagesStanding(2)()).toBe(false)

    again()
  })

  it("takes a closed document's pages off the clipboard with it", () => {
    const unregister = registerPageSource(1, source([], "one"))
    const held = taken(1)

    holdPages(held)
    unregister()
    expect(heldPages()).toBeNull()
    expect(pageSourceOf(held)).toBeUndefined()
  })
})
