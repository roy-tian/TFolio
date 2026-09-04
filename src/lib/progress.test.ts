import { describe, expect, test } from "bun:test"

import { PdfOperationCancelled, progressPercent } from "@/lib/progress"

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

describe("PdfOperationCancelled", () => {
  test("is recognisable by the branches that tell a stop from a failure", () => {
    const stopped: unknown = new PdfOperationCancelled()

    // Four call sites decide what to show the reader on `instanceof` alone,
    // so it has to survive being caught as a plain `unknown` error.
    expect(stopped instanceof PdfOperationCancelled).toBe(true)
    expect(stopped instanceof Error).toBe(true)
    expect((stopped as Error).name).toBe("PdfOperationCancelled")
  })
})
