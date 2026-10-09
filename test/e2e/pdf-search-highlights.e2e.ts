import { mkdirSync } from "node:fs"
import { $, browser, expect } from "@wdio/globals"

import { fragmentedTextPdf, openPdfFromDisk, refreshApp, renderedPage, seedSettings } from "./helpers"
import { calibratePointer, pointer } from "./nativePointer"

async function compareSelection() {
  await $(".pdf-selection-layer span").waitForExist()
  const boxes = await browser.execute(() => {
    const box = (selector: string) => {
      const { left, top, width, height } = document.querySelector(selector)!.getBoundingClientRect()
      return { left, top, width, height }
    }
    return {
      // PDFium includes spacing in the earlier runs; the standalone "e"
      // selected below is the final glyph of the first row (its third hit).
      search: box("[data-search-match='2']"),
      selection: box(".pdf-selection-layer span"),
    }
  })
  for (const axis of ["left", "top", "width", "height"] as const) {
    expect(Math.abs(boxes.search[axis] - boxes.selection[axis])).toBeLessThan(0.2)
  }
}

describe("TFolio search highlight appearance", () => {
  it("matches mouse selection bounds and clearly darkens only the current hit", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("search-highlight-height.pdf", fragmentedTextPdf(true))
    await renderedPage()
    await $("button[aria-label='Fit page']").click()
    await $(".pdf-text-layer span").waitForExist()
    await $("button[aria-label='Search this PDF']").click()
    await $("input[aria-label='Search text in current PDF']").setValue("e")
    await expect($("[data-slot='pdf-search-status']")).toHaveText("1 / 18")

    const offset = await calibratePointer()
    const glyph = await browser.execute(() => {
      const span = [...document.querySelectorAll(".pdf-text-layer span")].find(span => span.textContent === "e")!
      const { left, right, top, height } = span.getBoundingClientRect()
      return { left, right, y: top + height / 2 }
    })
    pointer({ x: glyph.left + 0.2 + offset.x, y: glyph.y + offset.y })
    pointer({ down: true })
    try {
      pointer({ x: glyph.right - 0.2 + offset.x, y: glyph.y + offset.y })
      await browser.waitUntil(() => browser.execute(() => window.getSelection()?.toString() === "e"))
    } finally {
      pointer({ down: false })
    }
    await compareSelection()

    await $("button[aria-label='Zoom in']").click()
    // Recreate the same native range after the toolbar takes focus.
    await browser.execute(() => {
      const span = [...document.querySelectorAll(".pdf-text-layer span")].find(span => span.textContent === "e")!
      const range = document.createRange()
      range.selectNodeContents(span)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await compareSelection()
    await browser.execute(() => window.getSelection()!.removeAllRanges())

    const colors = () => browser.execute(() => {
      const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor
      return {
        active: color("[data-search-match='0']"),
        inactive: color("[data-search-match='1']"),
      }
    })
    const before = await colors()
    // Compare composited brightness on white, not merely unequal CSS strings.
    const brightness = (color: string) => {
      const [r, g, b, alpha = 1] = color.match(/[\d.]+/g)!.map(Number)
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) * alpha + 255 * (1 - alpha)
    }
    expect(brightness(before.inactive) - brightness(before.active)).toBeGreaterThan(50)
    mkdirSync("artifacts/e2e", { recursive: true })
    await browser.saveScreenshot("artifacts/e2e/search-highlights.png")
    await $("button[aria-label='Next result']").click()
    await expect($("[data-slot='pdf-search-status']")).toHaveText("2 / 18")
    expect(await colors()).toEqual({ active: before.inactive, inactive: before.active })
  })
})
