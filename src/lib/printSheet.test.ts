import { describe, expect, it } from "bun:test"

import { MAX_RENDER_WIDTH, MIN_RENDER_WIDTH } from "./pdf"
import {
  MIN_PRINT_DPI,
  PRINT_BUDGET_PAGES,
  PRINT_DPI,
  pngDataUrl,
  printDpi,
  printRenderWidth,
} from "./printSheet"

describe("printDpi", () => {
  it("gives a document within the budget the full resolution", () => {
    expect(printDpi(1)).toBe(PRINT_DPI)
    expect(printDpi(PRINT_BUDGET_PAGES)).toBe(PRINT_DPI)
  })

  it("holds a longer document to about the budget's pixels", () => {
    const budget = PRINT_BUDGET_PAGES * PRINT_DPI ** 2
    const pages = PRINT_BUDGET_PAGES * 4

    expect(pages * printDpi(pages) ** 2).toBeLessThanOrEqual(budget * 1.01)
  })

  it("never falls below the readable floor", () => {
    expect(printDpi(100_000)).toBe(MIN_PRINT_DPI)
  })

  it("answers an empty document rather than dividing by its length", () => {
    expect(printDpi(0)).toBe(PRINT_DPI)
  })
})

describe("printRenderWidth", () => {
  it("scales a page's points to the asked-for resolution", () => {
    expect(printRenderWidth(612, 150)).toBe(1275)
    expect(printRenderWidth(595.28, 72)).toBe(595)
  })

  it("clamps to what the backend accepts at either end", () => {
    expect(printRenderWidth(2, 150)).toBe(MIN_RENDER_WIDTH)
    expect(printRenderWidth(5000, 300)).toBe(MAX_RENDER_WIDTH)
  })
})

describe("pngDataUrl", () => {
  it("names the bytes as a PNG the CSP already allows", () => {
    const bytes = Uint8Array.from([137, 80, 78, 71])

    expect(pngDataUrl(bytes.buffer)).toBe("data:image/png;base64,iVBORw==")
  })

  it("carries bytes past one call's argument limit", () => {
    const bytes = new Uint8Array(300_000).fill(255)

    expect(pngDataUrl(bytes.buffer)).toBe(
      `data:image/png;base64,${btoa("ÿ".repeat(300_000))}`,
    )
  })
})
