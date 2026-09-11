import { describe, expect, it } from "bun:test"

import {
  clipboardAfterPaste,
  formatPageRanges,
  pageClipboardOf,
  pastePlan,
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
    // Pasting a cut back in front of itself, which is where it already is.
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
