import { describe, expect, test } from "bun:test"

import { progressPercent } from "@/lib/progress"

describe("progressPercent", () => {
  test("rounds a valid operation to a whole percentage", () => {
    expect(progressPercent({ completed: 3, total: 8 })).toBe(38)
  })

  test("bounds malformed and out-of-range progress", () => {
    expect(progressPercent({ completed: -1, total: 4 })).toBe(0)
    expect(progressPercent({ completed: 10, total: 4 })).toBe(100)
    expect(progressPercent({ completed: 1, total: 0 })).toBe(0)
    expect(progressPercent({ completed: Number.NaN, total: 4 })).toBe(0)
  })
})
