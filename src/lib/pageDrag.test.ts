import { describe, expect, it } from "bun:test"

import {
  dropGapForPoint,
  exceedsDragThreshold,
  orderAfterMove,
  type CellBox,
} from "@/lib/pageDrag"

/** A grid of uniform cells, as the thumbnail layout arranges them. */
function grid(count: number, columns: number): CellBox[] {
  const width = 160
  const height = 220
  const gap = 16

  return Array.from({ length: count }, (_, index) => ({
    height,
    left: (index % columns) * (width + gap),
    top: Math.floor(index / columns) * (height + gap),
    width,
  }))
}

describe("exceedsDragThreshold", () => {
  it("keeps a wobbling click a click", () => {
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(false)
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 10, y: 15 })).toBe(true)
  })
})

describe("dropGapForPoint", () => {
  const cells = grid(6, 3)

  it("finds the gap left of a cell from the pointer's half", () => {
    // Left half of the first cell: before page 1.
    expect(dropGapForPoint({ x: 40, y: 100 }, cells, 3)).toBe(0)
    // Right half of the first cell: between pages 1 and 2.
    expect(dropGapForPoint({ x: 120, y: 100 }, cells, 3)).toBe(1)
    // Past the last cell of the row: after page 3.
    expect(dropGapForPoint({ x: 520, y: 100 }, cells, 3)).toBe(3)
  })

  it("lands in the row the pointer is in", () => {
    // Second row, left half of its first cell: before page 4.
    expect(dropGapForPoint({ x: 40, y: 340 }, cells, 3)).toBe(3)
    // Second row, right edge: after page 6.
    expect(dropGapForPoint({ x: 520, y: 340 }, cells, 3)).toBe(6)
  })

  it("clamps to the nearest row above and below the grid", () => {
    expect(dropGapForPoint({ x: 40, y: -50 }, cells, 3)).toBe(0)
    expect(dropGapForPoint({ x: 520, y: 900 }, cells, 3)).toBe(6)
  })

  it("answers 0 for an empty grid", () => {
    expect(dropGapForPoint({ x: 40, y: 40 }, [], 3)).toBe(0)
  })
})

describe("orderAfterMove", () => {
  it("moves one page forward and back", () => {
    // Page 4 dropped before page 2.
    expect(orderAfterMove([4], 1, 5)).toEqual([1, 4, 2, 3, 5])
    // Page 1 dropped after page 3.
    expect(orderAfterMove([1], 3, 5)).toEqual([2, 3, 1, 4, 5])
  })

  it("keeps a multi-selection's relative order whatever the drag handle", () => {
    expect(orderAfterMove([2, 5], 0, 5)).toEqual([2, 5, 1, 3, 4])
    expect(orderAfterMove([5, 2], 0, 5)).toEqual([2, 5, 1, 3, 4])
  })

  it("drops into a gap inside the dragged block as the identity", () => {
    // Dropping pages 2-3 between themselves changes nothing.
    expect(orderAfterMove([2, 3], 2, 5)).toEqual([1, 2, 3, 4, 5])
    expect(orderAfterMove([2], 1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(orderAfterMove([2], 2, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it("moves a block to the very end", () => {
    expect(orderAfterMove([1, 2], 5, 5)).toEqual([3, 4, 5, 1, 2])
  })
})
