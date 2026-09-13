import { mkdirSync } from "node:fs"
import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import { appMenuItemEnabled, clickAppMenuItem, minimalPdf, openPdfFromDisk, refreshApp, renderedPage, seedSettings } from "./helpers"

type ArchiveSeam = Window & {
  __tfolioE2E?: E2eOverrides
  __archiveRequest?: { format: string; suggestedName: string; documentId: number }
}

describe("TFolio archive export", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("disables export on the home tab", async () => {
    expect(await appMenuItemEnabled("export")).toBe(false)
  })

  it("exports either image format for the current document", async () => {
    await openPdfFromDisk("archive.pdf", minimalPdf(3))
    await renderedPage()
    await browser.execute(() => {
      const seam = window as ArchiveSeam
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        exportPdfArchive: async (args, onProgress) => {
          seam.__archiveRequest = args
          onProgress({ completed: 3, total: 3 })
          return "/export/archive.zip"
        },
      }
    })
    for (const format of ["jpg", "png"]) {
      await clickAppMenuItem("export")
      await $("[data-testid='archive-export-dialog']").waitForDisplayed()
      await expect($("[data-testid='archive-format-bookmarks']")).toHaveAttribute("aria-disabled", "true")
      await $(`[data-testid='archive-format-${format}']`).click()
      if (format === "jpg") {
        mkdirSync("artifacts/run", { recursive: true })
        await browser.saveScreenshot("artifacts/run/archive-export.png")
      }
      await $("[data-testid='archive-export-start']").click()
      await $("[data-testid='archive-export-dialog']").waitForExist({ reverse: true })
      const request = await browser.execute(() => (window as ArchiveSeam).__archiveRequest)
      expect(request?.format).toBe(format)
      expect(request?.suggestedName).toBe(`archive-${format}.zip`)
      expect(request?.documentId).toBeGreaterThan(0)
    }
  })

  it("keeps a failed export open for retry", async () => {
    await openPdfFromDisk("archive.pdf", minimalPdf())
    await renderedPage()
    await browser.execute(() => {
      const seam = window as ArchiveSeam
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        exportPdfArchive: async () => { throw new Error("disk full") },
      }
    })
    await clickAppMenuItem("export")
    await $("[data-testid='archive-export-start']").click()
    await expect($("[data-testid='archive-export-dialog'] [role='alert']")).toBeDisplayed()
    await expect($("[data-testid='archive-export-start']")).toBeEnabled()
    await $("[data-testid='archive-export-cancel']").click()
    await $("[data-testid='archive-export-dialog']").waitForExist({ reverse: true })
  })
})
