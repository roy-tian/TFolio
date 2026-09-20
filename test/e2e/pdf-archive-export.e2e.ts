import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { ArchiveExportRequest, ArchiveOptions } from "../../src/lib/archiveExport"
import type { E2eOverrides } from "../../src/lib/e2e"
import { appMenuItemEnabled, clickAppMenuItem, minimalPdf, openPdfFromDisk, refreshApp, renderedPage, seedSettings } from "./helpers"

type ArchiveSeam = Window & {
  __tfolioE2E?: E2eOverrides
  __archiveRequest?: ArchiveExportRequest & { documentId: number }
}

describe("TFolio archive export", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("disables both exports on the home tab", async () => {
    expect(await appMenuItemEnabled("export-images")).toBe(false)
    expect(await appMenuItemEnabled("split")).toBe(false)
  })

  it("exports the selected pages as the chosen image format", async () => {
    await openPdfFromDisk("archive.pdf", minimalPdf(3))
    await renderedPage()
    await browser.execute(() => {
      const seam = window as ArchiveSeam
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        exportPdfArchive: async (args, onProgress) => {
          seam.__archiveRequest = args
          onProgress({ completed: 2, total: 2 })
          return "/export/archive.zip"
        },
      }
    })
    for (const imageFormat of ["jpg", "png"] as const) {
      await clickAppMenuItem("export-images")
      await $("[data-testid='image-export-dialog']").waitForDisplayed()
      await $(`[data-testid='image-format-${imageFormat}']`).click()
      await $("[data-testid='image-dpi-600']").click()
      await $("[data-testid='image-pages-input']").setValue("1-2")
      await $("[data-testid='image-export-start']").click()
      await $("[data-testid='image-export-dialog']").waitForExist({ reverse: true })
      const request = await browser.execute(() => (window as ArchiveSeam).__archiveRequest)
      const options: ArchiveOptions = { format: "images", imageFormat, dpi: 600, pages: [1, 2] }
      expect(request?.options).toEqual(options)
      expect(request?.suggestedName).toBe(`archive-${imageFormat}.zip`)
      expect(request?.documentId).toBeGreaterThan(0)
    }
  })

  it("refuses a page range the document cannot honour", async () => {
    await openPdfFromDisk("archive.pdf", minimalPdf(2))
    await renderedPage()
    await clickAppMenuItem("export-images")
    const start = $("[data-testid='image-export-start']")
    await $("[data-testid='image-pages-input']").setValue("3")
    await expect(start).toBeDisabled()
    await $("[data-testid='image-pages-input']").setValue("2-1")
    await expect(start).toBeDisabled()
    await $("[data-testid='image-pages-input']").setValue("1-2")
    await expect(start).toBeEnabled()
    await $("[data-testid='image-export-cancel']").click()
    await $("[data-testid='image-export-dialog']").waitForExist({ reverse: true })
  })

  it("splits one PDF per page from the toolbar's save menu", async () => {
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
    await $("[data-slot='pdf-save-menu-trigger']").click()
    await $("[data-action='split']").click()
    await $("[data-testid='split-dialog']").waitForDisplayed()
    // A document without bookmarks starts on the mode it can run.
    await expect($("[data-testid='split-mode-bookmarks']")).toHaveAttribute("aria-disabled", "true")
    await $("[data-testid='split-export-start']").click()
    await $("[data-testid='split-dialog']").waitForExist({ reverse: true })
    const request = await browser.execute(() => (window as ArchiveSeam).__archiveRequest)
    expect(request?.options).toEqual({ format: "pages" })
    expect(request?.suggestedName).toBe("archive-split.zip")
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
    await clickAppMenuItem("export-images")
    await $("[data-testid='image-export-start']").click()
    await expect($("[data-testid='image-export-dialog'] [role='alert']")).toBeDisplayed()
    await expect($("[data-testid='image-export-start']")).toBeEnabled()
    await $("[data-testid='image-export-cancel']").click()
    await $("[data-testid='image-export-dialog']").waitForExist({ reverse: true })
  })
})
