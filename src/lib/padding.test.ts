import { describe, expect, test } from "bun:test"

import {
  paddingAroundDropped,
  paddingPositions,
  samePadding,
  sheetSpreads,
  sheetsOf,
  spreadPagesOf,
  spreadTurnTarget,
} from "./padding"

describe("sheets and spreads", () => {
  // Three pages of one file, then two of the next: a blank closes the first.
  const padding = [{ after: 3, height: 842, width: 595 }]
  const sheets = sheetsOf(5, padding)
  const spreads = sheetSpreads(sheets)

  test("stand the blank after the page it follows", () => {
    expect(sheets.map((sheet) => (sheet.kind === "page" ? sheet.pageNumber : "blank"))).toEqual([
      1, 2, 3, "blank", 4, 5,
    ])
  })

  test("pair sheets, so the next file opens a spread", () => {
    expect(spreadPagesOf(spreads, 3)).toEqual([3])
    expect(spreadPagesOf(spreads, 4)).toEqual([4, 5])
  })

  test("without blanks, pair pages from the first, a trailing odd page alone", () => {
    const plain = sheetSpreads(sheetsOf(5, []))

    expect(spreadPagesOf(plain, 4)).toEqual([3, 4])
    expect(spreadPagesOf(plain, 5)).toEqual([5])
    expect(spreadTurnTarget(plain, 4, 1)).toBe(5)
    expect(spreadTurnTarget(plain, 4, -1)).toBe(1)
    expect(spreadTurnTarget(plain, 5, 1)).toBe(5)
  })

  test("turn from spread to spread, staying put at the ends", () => {
    expect(spreadTurnTarget(spreads, 2, 1)).toBe(3)
    expect(spreadTurnTarget(spreads, 3, 1)).toBe(4)
    expect(spreadTurnTarget(spreads, 5, 1)).toBe(4)
    expect(spreadTurnTarget(spreads, 1, -1)).toBe(1)
  })
})

describe("samePadding", () => {
  test("tells blanks moved or resized from blanks that stand still", () => {
    const blank = { after: 3, height: 842, width: 595 }

    expect(samePadding([blank], [{ ...blank }])).toBe(true)
    expect(samePadding([blank], [{ ...blank, after: 4 }])).toBe(false)
    expect(samePadding([blank], [{ ...blank, width: 400 }])).toBe(false)
    expect(samePadding([blank], [])).toBe(false)
  })
})

describe("paddingPositions", () => {
  test("backs a file that would leave the next on an even page", () => {
    // One page of the first file, two of the next: a blank after page 1.
    expect(paddingPositions([0, 1, 1])).toEqual([0])
    expect(paddingPositions([0, 0, 1, 1])).toEqual([])
    expect(paddingPositions([0, 1, 2, 2])).toEqual([0, 1])
  })

  test("counts a file's every run, as its pages stand among another's", () => {
    // The blank after the first run turns the count even again for the next.
    expect(paddingPositions([0, 1, 1, 0])).toEqual([0])
    expect(paddingPositions([0, 1, 0])).toEqual([0, 1])
  })

  test("pads nothing for a file alone", () => {
    expect(paddingPositions([0, 0, 0])).toEqual([])
    expect(paddingPositions([])).toEqual([])
  })
})

describe("paddingAroundDropped", () => {
  test("backs the pages before files dropped after an odd count", () => {
    // Three pages of a document never given files: the new one starts on page 5.
    expect(paddingAroundDropped([undefined, undefined, undefined], 3)).toEqual([2])
    expect(paddingAroundDropped([undefined, undefined], 2)).toEqual([])
  })

  test("parts a file where they drop, the rest of it starting on an odd page", () => {
    expect(paddingAroundDropped([0, 0, 0], 1)).toEqual([0])
    expect(paddingAroundDropped([0, 0, 0, 0], 2)).toEqual([])
    // The rest starts afresh, so its own count decides the blank before the
    // next file: two pages left drop the blank three had, three bring one.
    expect(paddingAroundDropped([0, 0, 0, 1], 1)).toEqual([0])
    expect(paddingAroundDropped([0, 0, 0, 0, 1], 1)).toEqual([0, 3])
  })

  test("keeps the blanks of files the drop leaves alone", () => {
    expect(paddingAroundDropped([0, 0, 0, 1, 1], 5)).toEqual([2])
    expect(paddingAroundDropped([0, 0, 0, 1, 1], 0)).toEqual([2])
  })
})
