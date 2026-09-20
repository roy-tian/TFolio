import { describe, expect, test } from "bun:test"

import { parsePageRange } from "@/lib/pageRange"

describe("parsePageRange", () => {
  test("blank input selects every page", () => {
    expect(parsePageRange("", 5)).toEqual({ kind: "all" })
    expect(parsePageRange("  ", 5)).toEqual({ kind: "all" })
  })

  test("names single pages and ranges, sorted and deduplicated", () => {
    expect(parsePageRange("3", 5)).toEqual({ kind: "pages", pages: [3] })
    expect(parsePageRange("2-4", 5)).toEqual({ kind: "pages", pages: [2, 3, 4] })
    expect(parsePageRange("4, 1, 2-3", 5)).toEqual({
      kind: "pages",
      pages: [1, 2, 3, 4],
    })
    expect(parsePageRange("2-3, 3, 1", 5)).toEqual({
      kind: "pages",
      pages: [1, 2, 3],
    })
  })

  test("accepts the full-width comma and spaced dashes", () => {
    expect(parsePageRange("1，3", 5)).toEqual({ kind: "pages", pages: [1, 3] })
    expect(parsePageRange("1 - 2", 5)).toEqual({ kind: "pages", pages: [1, 2] })
  })

  test("refuses what the shorthand cannot name", () => {
    expect(parsePageRange("1-", 5).kind).toBe("invalid")
    expect(parsePageRange("-3", 5).kind).toBe("invalid")
    expect(parsePageRange("3-1", 5).kind).toBe("invalid")
    expect(parsePageRange("1,,2", 5).kind).toBe("invalid")
    expect(parsePageRange("1;a", 5).kind).toBe("invalid")
    expect(parsePageRange("one", 5).kind).toBe("invalid")
  })

  test("names the page that left the document", () => {
    expect(parsePageRange("0", 3)).toEqual({ kind: "beyond", page: 0 })
    expect(parsePageRange("4", 3)).toEqual({ kind: "beyond", page: 4 })
    expect(parsePageRange("2-6", 3)).toEqual({ kind: "beyond", page: 4 })
    expect(parsePageRange("0-2", 3)).toEqual({ kind: "beyond", page: 0 })
    expect(parsePageRange("5-999999999", 3)).toEqual({ kind: "beyond", page: 5 })
    expect(parsePageRange("1-999999999", 3)).toEqual({ kind: "beyond", page: 4 })
    expect(parsePageRange("5, 2-8", 3)).toEqual({ kind: "beyond", page: 4 })
  })
})
