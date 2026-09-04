import { describe, expect, it } from "bun:test"

import {
  firstSearchMatchFromPage,
  stepSearchMatch,
} from "@/lib/pdfSearch"

const match = (pageNumber: number) => ({ pageNumber, rects: [] })

describe("PDF search navigation", () => {
  it("starts at the first occurrence at or after the page being read", () => {
    const matches = [match(1), match(3), match(3), match(8)]

    expect(firstSearchMatchFromPage(matches, 3)).toBe(1)
    expect(firstSearchMatchFromPage(matches, 4)).toBe(3)
    expect(firstSearchMatchFromPage(matches, 9)).toBe(0)
    expect(firstSearchMatchFromPage([], 1)).toBeNull()
  })

  it("steps in either direction and wraps", () => {
    expect(stepSearchMatch(0, 3, -1)).toBe(2)
    expect(stepSearchMatch(2, 3, 1)).toBe(0)
    expect(stepSearchMatch(null, 3, 1)).toBe(0)
    expect(stepSearchMatch(null, 3, -1)).toBe(2)
    expect(stepSearchMatch(0, 0, 1)).toBeNull()
  })
})
