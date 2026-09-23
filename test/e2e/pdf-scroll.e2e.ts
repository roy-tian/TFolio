import { $, browser, expect } from "@wdio/globals"

import { minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "./helpers"

describe("PDF scrolling", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("renders the next page before it reaches the viewer", async () => {
    await openPdfFromDisk("prefetch.pdf", minimalPdf(3, "0 0 595 842"))
    const nextPage = $(
      "[data-document-session][data-active='true'] [data-page-number='2']",
    )
    await nextPage.waitForExist()

    const before = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const page = viewer.querySelector<HTMLElement>("[data-page-number='2']")!

      return {
        gap:
          page.getBoundingClientRect().top -
          viewer.getBoundingClientRect().bottom,
        scrollTop: viewer.scrollTop,
      }
    })
    expect(before.gap).toBeGreaterThan(0)
    expect(before.gap).toBeLessThan(800)

    await nextPage.$("canvas[data-rendered='true']").waitForExist({
      timeout: 30_000,
      timeoutMsg: "the next page was not rendered ahead of the viewport",
    })
    const after = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const page = viewer.querySelector<HTMLElement>("[data-page-number='2']")!

      return {
        gap:
          page.getBoundingClientRect().top -
          viewer.getBoundingClientRect().bottom,
        scrollTop: viewer.scrollTop,
      }
    })
    expect(after.scrollTop).toBe(before.scrollTop)
    expect(after.gap).toBeGreaterThan(0)
  })
})
