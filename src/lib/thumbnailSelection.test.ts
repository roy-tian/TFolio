import { describe, expect, it } from "bun:test"

import {
  choiceAfterClick,
  emptySelection,
  plainChoiceWatch,
  selectionAfterClick,
  selectionAfterGroupClick,
  selectionOfAllPages,
  selectionWithout,
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

describe("selectionWithout", () => {
  it("lets go of the pages named and keeps the rest", () => {
    const chosen = selectionAfterClick(selectionAfterClick(emptySelection, 2, plain), 6, range)
    const left = selectionWithout(chosen, [4, 5, 9])

    expect(pagesOf(left)).toEqual([2, 3, 6])
    expect(left.anchor).toBe(2)
  })

  it("drops an anchor among them, so the next range starts afresh", () => {
    const chosen = selectionAfterClick(selectionAfterClick(emptySelection, 4, plain), 1, toggle)
    const left = selectionWithout(chosen, [1, 2])

    expect(pagesOf(left)).toEqual([4])
    expect(left.anchor).toBeNull()
    expect(pagesOf(selectionAfterClick(left, 6, range))).toEqual([6])
  })

  it("is the same selection where none of them was chosen", () => {
    const chosen = selectionAfterClick(emptySelection, 2, plain)

    expect(selectionWithout(chosen, [5, 6])).toBe(chosen)
  })
})

describe("selectionOfAllPages", () => {
  it("takes every page and anchors on the first", () => {
    const selection = selectionOfAllPages(4)

    expect(pagesOf(selection)).toEqual([1, 2, 3, 4])
    expect(selection.anchor).toBe(1)
  })

  it("has nothing to select in a document without pages", () => {
    expect(selectionOfAllPages(0).pages.size).toBe(0)
    expect(selectionOfAllPages(0).anchor).toBeNull()
  })

  it("leaves a following shift-click spanning from the first page", () => {
    const narrowed = selectionAfterClick(selectionOfAllPages(6), 3, range)

    expect(pagesOf(narrowed)).toEqual([1, 2, 3])
  })
})

describe("choiceAfterClick", () => {
  const order = [7, 3, 9, 5]

  it("spans from the anchor in list order, keeping the anchor", () => {
    expect(choiceAfterClick(order, new Set([3]), 3, 5, range)).toEqual({
      anchor: 3,
      chosen: new Set([3, 9, 5]),
    })
  })

  it("takes a range from an anchor no longer listed as a plain click", () => {
    expect(choiceAfterClick(order, new Set([1]), 1, 9, range)).toEqual({
      anchor: 9,
      chosen: new Set([9]),
    })
  })

  it("toggles one item and moves the anchor to it", () => {
    expect(choiceAfterClick(order, new Set([7, 9]), 7, 9, toggle)).toEqual({
      anchor: 9,
      chosen: new Set([7]),
    })
  })
})

describe("selectionAfterGroupClick", () => {
  it("chooses a file's pages alone on a plain click", () => {
    const before = selectionAfterClick(emptySelection, 1, plain)
    const file = selectionAfterGroupClick(before, [4, 5, 6], plain)

    expect(pagesOf(file)).toEqual([4, 5, 6])
    expect(file.anchor).toBe(4)
  })

  it("adds a file's pages with a toggle, and lets them go once all are chosen", () => {
    const one = selectionAfterClick(emptySelection, 1, plain)
    const added = selectionAfterGroupClick(one, [3, 4], toggle)

    expect(pagesOf(added)).toEqual([1, 3, 4])
    expect(pagesOf(selectionAfterGroupClick(added, [3, 4], toggle))).toEqual([1])
  })

  it("reaches from the anchor to the file's far end with a range", () => {
    const anchored = selectionAfterClick(emptySelection, 2, plain)

    expect(pagesOf(selectionAfterGroupClick(anchored, [5, 6], range))).toEqual([2, 3, 4, 5, 6])

    const later = selectionAfterClick(emptySelection, 7, plain)

    expect(pagesOf(selectionAfterGroupClick(later, [3, 4], range))).toEqual([3, 4, 5, 6, 7])
  })
})

describe("plainChoiceWatch", () => {
  it("keeps the choice through the pages its jump passes, and lets go once the reader reads on", () => {
    const watch = plainChoiceWatch(5)

    // The jump names its page before it scrolls, then passes the others.
    expect([5, 1, 2, 3, 4, 5].map(watch.heard)).toEqual([false, false, false, false, false, false])
    expect(watch.landed).toBe(true)
    expect(watch.heard(6)).toBe(true)
  })

  it("keeps it while the reader comes no farther than where the jump fell quiet", () => {
    // The last page never reaches the top: the jump settles a page short.
    const watch = plainChoiceWatch(8)

    watch.heard(6)
    watch.settle(7)
    expect(watch.heard(8)).toBe(false)
    expect(watch.heard(7)).toBe(true)
  })

  it("lets go of the page read when it was clicked once the reader leaves it", () => {
    const watch = plainChoiceWatch(3)

    watch.settle(3)
    expect(watch.heard(4)).toBe(true)
  })

  it("measures a choice out of reach from where reading stood as it settled", () => {
    const watch = plainChoiceWatch(3)

    watch.settle(10)
    expect(watch.heard(9)).toBe(false)
    expect(watch.heard(10)).toBe(true)
  })

  it("lands again where a move the app made leaves the reader", () => {
    const watch = plainChoiceWatch(8)

    watch.settle(7)
    watch.unsettle()
    // A turn of the last page clamped the scroll back two pages.
    expect(watch.heard(6)).toBe(false)
    watch.settle(6)
    expect(watch.heard(7)).toBe(false)
    expect(watch.heard(5)).toBe(true)
  })
})
