import { describe, expect, test } from "bun:test"

import {
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
