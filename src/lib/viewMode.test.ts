import { describe, expect, test } from "bun:test"

import {
  computeThumbnailColumns,
  effectiveViewMode,
  isViewMode,
  pageTurnTarget,
  pairPages,
  spreadPages,
  THUMBNAIL_COLUMN_GAP,
  THUMBNAIL_WIDTH,
} from "./viewMode"

describe("isViewMode", () => {
  test("accepts the supported modes", () => {
    expect(isViewMode("single")).toBe(true)
    expect(isViewMode("book")).toBe(true)
    expect(isViewMode("thumbnail")).toBe(true)
  })

  test("rejects anything else", () => {
    expect(isViewMode("grid")).toBe(false)
    expect(isViewMode(null)).toBe(false)
  })
})

describe("pairPages", () => {
  test("returns no rows for an empty document", () => {
    expect(pairPages(0)).toEqual([])
  })

  test("pairs from the first page rather than holding a cover back", () => {
    expect(pairPages(6)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
  })

  // The lone page keeps the left slot so it renders at spread size, not double.
  test("leaves a trailing odd page alone in its row", () => {
    expect(pairPages(5)).toEqual([[1, 2], [3, 4], [5]])
  })

  test("handles a single-page document", () => {
    expect(pairPages(1)).toEqual([[1]])
  })
})

describe("spreadPages", () => {
  test("returns the row a page sits in, from either half", () => {
    expect(spreadPages(3, 6)).toEqual([3, 4])
    expect(spreadPages(4, 6)).toEqual([3, 4])
  })

  test("leaves a trailing odd page alone", () => {
    expect(spreadPages(5, 5)).toEqual([5])
  })
})

describe("pageTurnTarget", () => {
  test("turns one page at a time in single-page view", () => {
    expect(pageTurnTarget(3, 7, "single", 1)).toBe(4)
    expect(pageTurnTarget(3, 7, "single", -1)).toBe(2)
  })

  test("turns one whole spread from either half in book view", () => {
    expect(pageTurnTarget(3, 8, "book", 1)).toBe(5)
    expect(pageTurnTarget(4, 8, "book", 1)).toBe(5)
    expect(pageTurnTarget(3, 8, "book", -1)).toBe(1)
    expect(pageTurnTarget(4, 8, "book", -1)).toBe(1)
  })

  test("stays on the first or last page row at the document bounds", () => {
    expect(pageTurnTarget(1, 6, "single", -1)).toBe(1)
    expect(pageTurnTarget(6, 6, "single", 1)).toBe(6)
    expect(pageTurnTarget(2, 6, "book", -1)).toBe(1)
    expect(pageTurnTarget(6, 6, "book", 1)).toBe(5)
    expect(pageTurnTarget(5, 5, "book", 1)).toBe(5)
  })
})

describe("computeThumbnailColumns", () => {
  const columnStride = THUMBNAIL_WIDTH + THUMBNAIL_COLUMN_GAP

  test("never drops below two columns", () => {
    expect(computeThumbnailColumns(0)).toBe(2)
    expect(computeThumbnailColumns(THUMBNAIL_WIDTH)).toBe(2)
  })

  test("rounds an odd fit down to an even count", () => {
    // Exactly three columns fit; a row must stay even.
    expect(computeThumbnailColumns(columnStride * 3 - THUMBNAIL_COLUMN_GAP)).toBe(2)
    expect(computeThumbnailColumns(columnStride * 5 - THUMBNAIL_COLUMN_GAP)).toBe(4)
  })

  test("uses every column an even fit allows", () => {
    expect(computeThumbnailColumns(columnStride * 4 - THUMBNAIL_COLUMN_GAP)).toBe(4)
    expect(computeThumbnailColumns(columnStride * 6 - THUMBNAIL_COLUMN_GAP)).toBe(6)
  })
})

describe("effectiveViewMode", () => {
  test("falls back to single when there is no spread to show", () => {
    expect(effectiveViewMode("book", 1)).toBe("single")
    expect(effectiveViewMode("book", 0)).toBe("single")
  })

  test("keeps book once a second page gives it a spread", () => {
    expect(effectiveViewMode("book", 2)).toBe("book")
  })

  test("leaves every other mode to stand on its own", () => {
    expect(effectiveViewMode("single", 1)).toBe("single")
    expect(effectiveViewMode("thumbnail", 1)).toBe("thumbnail")
  })
})
