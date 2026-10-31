import { describe, expect, test } from "bun:test"

import {
  effectiveViewMode,
  isViewMode,
  pageTurnTarget,
  pairPages,
  spreadPages,
  THUMBNAIL_WIDTH,
  thumbnailPaper,
} from "./viewMode"

describe("isViewMode", () => {
  test("accepts the supported modes", () => {
    expect(isViewMode("single")).toBe(true)
    expect(isViewMode("book")).toBe(true)
    // The grid a stored setting may still name went with the sidebar's previews.
    expect(isViewMode("thumbnail")).toBe(false)
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

describe("thumbnailPaper", () => {
  test("spans the column with the long side", () => {
    expect(thumbnailPaper({ height: 842, width: 595 }).height).toBe(THUMBNAIL_WIDTH)
    expect(thumbnailPaper({ height: 595, width: 842 }).width).toBe(THUMBNAIL_WIDTH)
  })

  test("keeps one scale for a page turned either way", () => {
    const portrait = thumbnailPaper({ height: 842, width: 595 })
    const landscape = thumbnailPaper({ height: 595, width: 842 })

    expect(landscape.width).toBeCloseTo(portrait.height)
    expect(landscape.height).toBeCloseTo(portrait.width)
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

  test("leaves single page to stand on its own", () => {
    expect(effectiveViewMode("single", 1)).toBe("single")
  })
})
