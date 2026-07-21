import { describe, expect, test } from "bun:test"

import {
  computeThumbnailColumns,
  isViewMode,
  pairPages,
  THUMBNAIL_GAP,
  THUMBNAIL_WIDTH,
} from "./viewMode"

describe("isViewMode", () => {
  test("accepts the supported modes", () => {
    expect(isViewMode("single")).toBe(true)
    expect(isViewMode("book")).toBe(true)
    expect(isViewMode("thumbnail")).toBe(true)
    expect(isViewMode("files")).toBe(true)
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

describe("computeThumbnailColumns", () => {
  const columnStride = THUMBNAIL_WIDTH + THUMBNAIL_GAP

  test("never drops below two columns", () => {
    expect(computeThumbnailColumns(0)).toBe(2)
    expect(computeThumbnailColumns(THUMBNAIL_WIDTH)).toBe(2)
  })

  test("rounds an odd fit down to an even count", () => {
    // Exactly three columns fit; a row must stay even.
    expect(computeThumbnailColumns(columnStride * 3 - THUMBNAIL_GAP)).toBe(2)
    expect(computeThumbnailColumns(columnStride * 5 - THUMBNAIL_GAP)).toBe(4)
  })

  test("uses every column an even fit allows", () => {
    expect(computeThumbnailColumns(columnStride * 4 - THUMBNAIL_GAP)).toBe(4)
    expect(computeThumbnailColumns(columnStride * 6 - THUMBNAIL_GAP)).toBe(6)
  })
})
