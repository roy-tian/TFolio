import { describe, expect, it } from "bun:test"

import {
  emptySelection,
  selectionAfterClick,
  selectionAfterStructureChange,
  type ThumbnailSelection,
} from "@/lib/thumbnailSelection"

const plain = { range: false, toggle: false }
const toggle = { range: false, toggle: true }
const range = { range: true, toggle: false }

function pagesOf(selection: ThumbnailSelection) {
  return [...selection.pages].sort((left, right) => left - right)
}

describe("selectionAfterClick", () => {
  it("replaces the selection on a plain click", () => {
    const first = selectionAfterClick(emptySelection, 3, plain)
    const second = selectionAfterClick(first, 5, plain)

    expect(pagesOf(second)).toEqual([5])
    expect(second.anchor).toBe(5)
  })

  it("toggles membership on a modified click", () => {
    const first = selectionAfterClick(emptySelection, 3, plain)
    const grown = selectionAfterClick(first, 5, toggle)

    expect(pagesOf(grown)).toEqual([3, 5])

    const shrunk = selectionAfterClick(grown, 3, toggle)

    expect(pagesOf(shrunk)).toEqual([5])
    // The toggle moves the anchor even as it removes, so the next shift-range
    // starts from the page just handled — as file managers behave.
    expect(shrunk.anchor).toBe(3)
  })

  it("spans a range from the anchor on shift", () => {
    const anchored = selectionAfterClick(emptySelection, 2, plain)
    const spanned = selectionAfterClick(anchored, 5, range)

    expect(pagesOf(spanned)).toEqual([2, 3, 4, 5])
    expect(spanned.anchor).toBe(2)

    // Re-spanning from the same anchor replaces, never accumulates.
    const respanned = selectionAfterClick(spanned, 1, range)

    expect(pagesOf(respanned)).toEqual([1, 2])
  })

  it("treats an anchorless shift-click as a plain click", () => {
    const selection = selectionAfterClick(emptySelection, 4, range)

    expect(pagesOf(selection)).toEqual([4])
    expect(selection.anchor).toBe(4)
  })
})

describe("selectionAfterStructureChange", () => {
  it("keeps nothing, because page numbers name different pages now", () => {
    expect(selectionAfterStructureChange().pages.size).toBe(0)
    expect(selectionAfterStructureChange().anchor).toBeNull()
  })
})
