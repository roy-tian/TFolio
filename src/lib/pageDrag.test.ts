import { describe, expect, it } from "bun:test"

import {
  dropGapForPoint,
  dropGapForRow,
  exceedsDragThreshold,
  indexAfterMove,
  orderAfterMove,
  slotOffsets,
  type CellBox,
} from "@/lib/pageDrag"

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
    expect(dropGapForPoint({ x: 40, y: 100 }, cells, 3)).toBe(0)
    expect(dropGapForPoint({ x: 120, y: 100 }, cells, 3)).toBe(1)
    expect(dropGapForPoint({ x: 520, y: 100 }, cells, 3)).toBe(3)
  })

  it("lands in the row the pointer is in", () => {
    expect(dropGapForPoint({ x: 40, y: 340 }, cells, 3)).toBe(3)
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
    expect(orderAfterMove([4], 1, 5)).toEqual([1, 4, 2, 3, 5])
    expect(orderAfterMove([1], 3, 5)).toEqual([2, 3, 1, 4, 5])
  })

  it("keeps a multi-selection's relative order whatever the drag handle", () => {
    expect(orderAfterMove([2, 5], 0, 5)).toEqual([2, 5, 1, 3, 4])
    expect(orderAfterMove([5, 2], 0, 5)).toEqual([2, 5, 1, 3, 4])
  })

  it("drops into a gap inside the dragged block as the identity", () => {
    expect(orderAfterMove([2, 3], 2, 5)).toEqual([1, 2, 3, 4, 5])
    expect(orderAfterMove([2], 1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(orderAfterMove([2], 2, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it("moves a block to the very end", () => {
    expect(orderAfterMove([1, 2], 5, 5)).toEqual([3, 4, 5, 1, 2])
  })
})

describe("dropGapForRow", () => {
  const rows = [
    { height: 40, top: 0 },
    { height: 40, top: 50 },
    { height: 40, top: 100 },
  ]

  it("answers with the gap the pointer's own row half indicates", () => {
    expect(dropGapForRow(5, rows)).toBe(0)
    expect(dropGapForRow(30, rows)).toBe(1)
    expect(dropGapForRow(55, rows)).toBe(1)
    expect(dropGapForRow(80, rows)).toBe(2)
    expect(dropGapForRow(200, rows)).toBe(3)
  })

  it("puts an empty list's only gap at the front", () => {
    expect(dropGapForRow(40, [])).toBe(0)
  })
})

describe("indexAfterMove", () => {
  it("leaves an item dropped back where it already is", () => {
    expect(indexAfterMove(2, 2)).toBe(2)
    expect(indexAfterMove(2, 3)).toBe(2)
  })

  it("closes up over the hole a downward move leaves", () => {
    expect(indexAfterMove(0, 3)).toBe(2)
    expect(indexAfterMove(3, 1)).toBe(1)
  })
})

describe("slotOffsets", () => {
  // Three across, so a move within a row is horizontal and a move between rows
  // has both components.
  const cells = grid(6, 3)

  it("slides the pages a lifted one moves past, and leaves the rest", () => {
    const offsets = slotOffsets(orderAfterMove([1], 3, 6), cells, new Set([1]))

    expect(offsets.get(2)).toEqual({ x: -176, y: 0 })
    expect(offsets.get(3)).toEqual({ x: -176, y: 0 })
    expect(offsets.has(1)).toBe(false)
    expect(offsets.has(4)).toBe(false)
    expect(offsets.has(6)).toBe(false)
  })

  it("carries a page over the row break it is pushed across", () => {
    const offsets = slotOffsets(orderAfterMove([6], 0, 6), cells, new Set([6]))

    expect(offsets.get(3)).toEqual({ x: -352, y: 236 })
    expect(offsets.get(4)).toEqual({ x: 176, y: 0 })
  })

  it("has nothing to move for a drop that changes no order", () => {
    const offsets = slotOffsets(orderAfterMove([2], 2, 6), cells, new Set([2]))

    expect(offsets.size).toBe(0)
  })

  it("keeps a block together and skips the pages carrying it", () => {
    const offsets = slotOffsets(
      orderAfterMove([1, 2], 6, 6),
      cells,
      new Set([1, 2]),
    )

    expect(offsets.get(3)).toEqual({ x: -352, y: 0 })
    expect(offsets.get(4)).toEqual({ x: 176, y: -236 })
    expect(offsets.get(6)).toEqual({ x: -352, y: 0 })
    expect(offsets.has(1)).toBe(false)
    expect(offsets.has(2)).toBe(false)
  })
})
