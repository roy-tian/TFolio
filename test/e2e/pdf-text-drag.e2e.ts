import { $, browser, expect } from "@wdio/globals"

import {
  dropZoneButton,
  fragmentedTextPdf,
  openPdfFromDisk,
  refreshApp,
  renderedPage,
  seedSettings,
} from "./helpers"

import { calibratePointer, pointer } from "./nativePointer"

describe("TFolio native text dragging", () => {
  it("extends and retracts a continuous selection across fragmented lines", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist()
    await openPdfFromDisk("drag-fragments.pdf", fragmentedTextPdf(true))
    await renderedPage()
    await $("button[aria-label='Fit page']").click()
    await $(".pdf-text-layer span").waitForExist()

    const offset = await calibratePointer()
    const spans = await browser.execute(() => [...document.querySelectorAll(".pdf-text-layer span")].map((span) => {
      const box = span.getBoundingClientRect()
      return { left: box.left, top: box.top, width: box.width, height: box.height, text: span.textContent ?? "" }
    }))
    expect(spans).toHaveLength(60)
    const at = (index: number, fraction: number) => ({
      x: spans[index].left + spans[index].width * fraction + offset.x,
      y: spans[index].top + spans[index].height / 2 + offset.y,
    })

    pointer(at(0, 0.1))
    pointer({ down: true })
    try {
      for (const end of [3, 6, 9, 13, 19, 23, 13, 6]) {
        pointer(at(end, 0.9))
        const expected = spans.slice(0, end + 1).map((span) => span.text).join("").replaceAll(/\s/g, "")
        await browser.waitUntil(async () => {
          const selected = await browser.execute(() => ({
            text: window.getSelection()?.toString().replaceAll(/\s/g, ""),
            bands: document.querySelectorAll(".pdf-selection-layer span").length,
          }))
          return selected.text === expected && selected.bands === Math.floor(end / 10) + 1
        }, { timeoutMsg: `drag to glyph ${end} did not produce continuous selected lines` })
      }
    } finally {
      pointer({ down: false })
    }
    expect(await browser.execute(() => window.getSelection()?.toString().replaceAll(/\s/g, ""))).toBe("Selecta")

    pointer(at(19, 0.9))
    pointer({ down: true })
    try {
      pointer(at(3, 0.1))
      const expected = spans.slice(3, 20).map((span) => span.text).join("").replaceAll(/\s/g, "")
      await browser.waitUntil(async () => {
        const selected = await browser.execute(() => ({
          text: window.getSelection()?.toString().replaceAll(/\s/g, ""),
          bands: document.querySelectorAll(".pdf-selection-layer span").length,
        }))
        return selected.text === expected && selected.bands === 2
      }, { timeoutMsg: "backward drag did not select the same continuous text" })
    } finally {
      pointer({ down: false })
    }

    await browser.keys(["Control", "a"])
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelectorAll(".pdf-selection-layer span").length === 6,
    ), { timeoutMsg: "select-all did not paint one band per fragmented line" })
  })
})
