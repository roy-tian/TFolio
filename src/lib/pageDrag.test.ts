import { describe, expect, it } from "bun:test"

import {
  besideColumn,
  columnEdgeStep,
  columnLanding,
  dropGapForRow,
  exceedsDragThreshold,
  flowCellAt,
  flowLanding,
  indexAfterMove,
  movesNothing,
  nearestBox,
  orderAfterMove,
  orderWithBlockAt,
  pagesBeforeSlot,
  rowNeighbour,
  slotOfPages,
  wayOffsets,
} from "@/lib/pageDrag"

describe("the sidebar column's reach", () => {
  const column = { bottom: 600, left: 0, right: 240, top: 100 }

  it("keeps a pointer a little beside the column, and lets one further off go", () => {
    expect(besideColumn(260, column)).toBe(true)
    expect(besideColumn(300, column)).toBe(false)
  })

  it("scrolls near either edge, and only for a pointer beside the column", () => {
    expect(columnEdgeStep({ x: 120, y: 110 }, column)).toBeLessThan(0)
    expect(columnEdgeStep({ x: 120, y: 590 }, column)).toBeGreaterThan(0)
    expect(columnEdgeStep({ x: 120, y: 350 }, column)).toBe(0)
    expect(columnEdgeStep({ x: 600, y: 110 }, column)).toBe(0)
  })
})

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
    expect(indexAfterMove([2], 2)).toBe(2)
    expect(indexAfterMove([2], 3)).toBe(2)
  })

  it("closes up over the hole a downward move leaves", () => {
    expect(indexAfterMove([0], 3)).toBe(2)
    expect(indexAfterMove([3], 1)).toBe(1)
  })

  it("closes up over every hole a block leaves before the gap", () => {
    expect(indexAfterMove([0, 2], 4)).toBe(2)
    expect(indexAfterMove([0, 2], 2)).toBe(1)
    expect(indexAfterMove([1, 3], 0)).toBe(0)
  })
})

describe("movesNothing", () => {
  it("holds for a run landing on its own first place", () => {
    expect(movesNothing([2], 2)).toBe(true)
    expect(movesNothing([1, 2, 3], 1)).toBe(true)
  })

  it("fails for a run landing elsewhere, or a block gathering up", () => {
    expect(movesNothing([1, 2], 0)).toBe(false)
    expect(movesNothing([0, 2], 0)).toBe(false)
  })
})

describe("wayOffsets", () => {
  // Rows of 10, 30, 10 and 20 with 2 between them.
  const cells = [
    { height: 10, top: 0 },
    { height: 30, top: 12 },
    { height: 10, top: 44 },
    { height: 20, top: 56 },
  ]

  it("slides the items passed over by the moving item's own extent", () => {
    expect(wayOffsets([1], 3, cells)).toEqual([0, 0, -32, -32])
    expect(wayOffsets([3], 1, cells)).toEqual([0, 22, 22, 0])
  })

  it("slides each item by every moving item that passes it", () => {
    // 0 and 2 land after 3: 0 alone passes 1, and both pass 3.
    expect(wayOffsets([0, 2], 2, cells)).toEqual([0, -12, 0, -24])
    expect(wayOffsets([1, 3], 0, cells)).toEqual([54, 0, 22, 0])
  })

  it("moves nothing for a block landing where it stands", () => {
    expect(wayOffsets([1, 2], 1, cells)).toEqual([0, 0, 0, 0])
  })
})


describe("orderWithBlockAt", () => {
  it("puts the block among the pages that stay, in page order", () => {
    expect(orderWithBlockAt([4], 1, 5)).toEqual([1, 4, 2, 3, 5])
    expect(orderWithBlockAt([5, 2], 0, 5)).toEqual([2, 5, 1, 3, 4])
    expect(orderWithBlockAt([1, 2], 3, 5)).toEqual([3, 4, 5, 1, 2])
  })

  it("answers the identity for a block landing where it stands", () => {
    expect(orderWithBlockAt([2, 3], 1, 5)).toEqual([1, 2, 3, 4, 5])
  })
})

describe("columnLanding", () => {
  const rows = [
    { height: 40, moving: false, top: 0 },
    { height: 40, moving: true, top: 50 },
    { height: 40, moving: false, top: 100 },
  ]

  it("lands before or after the staying row under the pointer", () => {
    expect(columnLanding(-30, rows, null)).toBe(0)
    expect(columnLanding(30, rows, null)).toBe(1)
    expect(columnLanding(105, rows, null)).toBe(1)
    expect(columnLanding(300, rows, null)).toBe(2)
  })

  it("splits the gap between rows halfway", () => {
    expect(columnLanding(44, rows, 7)).toBe(1)
    expect(columnLanding(46, rows, 7)).toBe(7)
  })

  it("keeps the landing while the pointer is over the block's holes", () => {
    expect(columnLanding(70, rows, 2)).toBe(2)
    expect(columnLanding(70, rows, null)).toBeNull()
  })
})

describe("flowCellAt", () => {
  // Two lines: three cells, then a narrower and a wider one.
  const cells = [
    { height: 100, left: 0, top: 0, width: 80 },
    { height: 100, left: 100, top: 0, width: 80 },
    { height: 60, left: 200, top: 40, width: 120 },
    { height: 100, left: 0, top: 120, width: 60 },
    { height: 60, left: 80, top: 160, width: 120 },
  ]

  it("finds the cell and its half under the pointer", () => {
    expect(flowCellAt({ x: 10, y: 50 }, cells)).toEqual({ after: false, index: 0 })
    expect(flowCellAt({ x: 170, y: 50 }, cells)).toEqual({ after: true, index: 1 })
    expect(flowCellAt({ x: 150, y: 200 }, cells)).toEqual({ after: true, index: 4 })
  })

  it("gives gaps and the space past a line's end to the nearest cell", () => {
    expect(flowCellAt({ x: 85, y: 50 }, cells)).toEqual({ after: true, index: 0 })
    expect(flowCellAt({ x: 95, y: 50 }, cells)).toEqual({ after: false, index: 1 })
    expect(flowCellAt({ x: 600, y: 50 }, cells)).toEqual({ after: true, index: 2 })
    expect(flowCellAt({ x: 600, y: 900 }, cells)).toEqual({ after: true, index: 4 })
    expect(flowCellAt({ x: 10, y: 109 }, cells)).toEqual({ after: false, index: 0 })
    expect(flowCellAt({ x: 10, y: 111 }, cells)).toEqual({ after: false, index: 3 })
  })

  it("has nothing to answer in an empty flow", () => {
    expect(flowCellAt({ x: 0, y: 0 }, [])).toBeNull()
  })
})

describe("flowLanding", () => {
  const cell = (left: number, top: number, moving = false) => ({
    height: 180,
    left,
    moving,
    top,
    width: 160,
  })

  it("reads a centred column of mixed widths by rows, not by its lefts", () => {
    const column = [
      { height: 182, left: 24, moving: false, top: 0, width: 113 },
      { height: 135, left: 0, moving: false, top: 194, width: 160 },
      { height: 182, left: 24, moving: false, top: 341, width: 113 },
    ]

    expect(flowLanding({ x: 150, y: 20 }, column, null)).toBe(0)
    expect(flowLanding({ x: 5, y: 300 }, column, null)).toBe(2)
    expect(flowLanding({ x: 5, y: 900 }, column, null)).toBe(3)
  })

  it("lands a grid's block before or after the cell under the pointer", () => {
    // Two rows of three, the second page in hand.
    const grid = [
      cell(0, 0),
      cell(172, 0, true),
      cell(344, 0),
      cell(0, 192),
      cell(172, 192),
      cell(344, 192),
    ]

    expect(flowLanding({ x: 20, y: 40 }, grid, null)).toBe(0)
    expect(flowLanding({ x: 150, y: 40 }, grid, null)).toBe(1)
    expect(flowLanding({ x: 300, y: 260 }, grid, null)).toBe(4)
    expect(flowLanding({ x: 480, y: 260 }, grid, null)).toBe(5)
  })

  it("keeps the landing still over the block's own holes", () => {
    const grid = [cell(0, 0), cell(172, 0, true), cell(344, 0)]

    expect(flowLanding({ x: 250, y: 40 }, grid, 2)).toBe(2)
    expect(flowLanding({ x: 250, y: 40 }, grid, null)).toBeNull()
  })

  it("lands above or below a folded file's name, a row of its own among the cells", () => {
    // A row of two pages, a folded file's bar, then one page more.
    const grid = [
      cell(0, 0),
      cell(184, 0),
      { bar: true, height: 28, left: 0, moving: false, top: 204, width: 344 },
      cell(0, 256),
    ]

    // Across the bar the half is told down it, not across it.
    expect(flowLanding({ x: 20, y: 210 }, grid, null)).toBe(2)
    expect(flowLanding({ x: 330, y: 210 }, grid, null)).toBe(2)
    expect(flowLanding({ x: 20, y: 226 }, grid, null)).toBe(3)
    expect(flowLanding({ x: 330, y: 226 }, grid, null)).toBe(3)
  })
})

describe("places among folded files", () => {
  // A page, a folded file of three, a page in hand, a folded file with every
  // page in hand, and a last page.
  const cells = [
    { moving: false, pages: 1 },
    { moving: false, pages: 3 },
    { moving: true, pages: 1 },
    { moving: true, pages: 0 },
    { moving: false, pages: 1 },
  ]

  it("counts a folded file as the pages under its name", () => {
    expect(pagesBeforeSlot(cells, 0)).toBe(0)
    expect(pagesBeforeSlot(cells, 1)).toBe(1)
    expect(pagesBeforeSlot(cells, 2)).toBe(4)
    expect(pagesBeforeSlot(cells, 3)).toBe(5)
  })

  it("finds the place a count of pages stands at, and back again", () => {
    for (const slot of [0, 1, 2, 3]) {
      expect(slotOfPages(cells, pagesBeforeSlot(cells, slot))).toBe(slot)
    }

    // No place stands inside a folded file: the next one after it.
    expect(slotOfPages(cells, 2)).toBe(2)
  })
})

describe("nearestBox", () => {
  const boxes = [
    { height: 100, left: 0, top: 0, width: 80 },
    { height: 100, left: 0, top: 140, width: 80 },
  ]

  it("takes the box under the point, or the nearest one", () => {
    expect(nearestBox({ x: 40, y: 50 }, boxes)).toBe(0)
    expect(nearestBox({ x: 40, y: 135 }, boxes)).toBe(1)
    expect(nearestBox({ x: 300, y: 105 }, boxes)).toBe(0)
    expect(nearestBox({ x: 0, y: 0 }, [])).toBe(-1)
  })
})

describe("the cell a row away", () => {
  const cell = (left: number, top: number) => ({ height: 184, left, top, width: 160 })
  // Three across, a file's name between the rows, then a short last row.
  const rows = [cell(0, 0), cell(184, 0), cell(368, 0), cell(0, 240), cell(184, 240), cell(0, 480)]
  // Cells by their place, reached one at a time the way the key points.
  const away = (cells: ReturnType<typeof cell>[], from: number, direction: 1 | -1) => {
    const measured: number[] = []
    const reached = rowNeighbour(
      from,
      (at) => (cells[at + direction] ? at + direction : null),
      (at) => {
        measured.push(at)

        return cells[at]!
      },
    )

    return { measured: new Set(measured).size, reached }
  }

  it("goes straight down or up where a cell stands there", () => {
    expect(away(rows, 1, 1).reached).toBe(4)
    expect(away(rows, 4, -1).reached).toBe(1)
  })

  it("takes the nearest cell of a shorter row", () => {
    expect(away(rows, 2, 1).reached).toBe(4)
    expect(away(rows, 4, 1).reached).toBe(5)
  })

  it("stops at the first row and the last", () => {
    expect(away(rows, 0, -1).reached).toBeNull()
    expect(away(rows, 5, 1).reached).toBeNull()
  })

  it("steps page by page down one column", () => {
    const column = [cell(0, 0), cell(0, 200), cell(0, 400)]

    expect(away(column, 0, 1).reached).toBe(1)
    expect(away(column, 2, -1).reached).toBe(1)
  })

  it("measures only the rows it crosses, however long the flow", () => {
    const long = Array.from({ length: 3000 }, (_, at) => cell((at % 3) * 184, Math.floor(at / 3) * 240))

    // The rest of its own row, the row below, and the first cell past that.
    expect(away(long, 1500, 1)).toEqual({ measured: 7, reached: 1503 })
  })
})
