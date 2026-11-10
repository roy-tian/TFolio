import { describe, expect, test } from "bun:test"

import {
  effectiveViewMode,
  isViewMode,
  pageTurnTarget,
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

describe("pageTurnTarget", () => {
  test("turns one page at a time", () => {
    expect(pageTurnTarget(3, 7, 1)).toBe(4)
    expect(pageTurnTarget(3, 7, -1)).toBe(2)
  })

  test("stays on the first or last page at the document bounds", () => {
    expect(pageTurnTarget(1, 6, -1)).toBe(1)
    expect(pageTurnTarget(6, 6, 1)).toBe(6)
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
