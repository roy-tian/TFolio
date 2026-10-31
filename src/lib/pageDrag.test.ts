import { describe, expect, it } from "bun:test"

import {
  dropGapForRow,
  exceedsDragThreshold,
  indexAfterMove,
  orderAfterMove,
} from "@/lib/pageDrag"

describe("exceedsDragThreshold", () => {
  it("keeps a wobbling click a click", () => {
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(false)
    expect(exceedsDragThreshold({ x: 10, y: 10 }, { x: 10, y: 15 })).toBe(true)
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

