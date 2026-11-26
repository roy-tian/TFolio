import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { ArchiveExportRequest, ArchiveOptions } from "../../src/lib/archiveExport"
import type { E2eOverrides } from "../../src/lib/e2e"
import {
  appMenuItem,
  appMenuItemEnabled,
  clickAppMenuItem,
  closeAppMenu,
  minimalPdf,
  openPdfFromDisk,
  outlinedPdf,
  refreshApp,
  renderedPage,
  seedSettings,
} from "./helpers"

type ArchiveSeam = Window & {
  __tfolioE2E?: E2eOverrides
  __archiveRequest?: ArchiveExportRequest & { documentId: number }
}

describe("TFolio archive export", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("places the four tools in their own group between Close all and Settings, without Print or a toolbar save menu", async () => {
    for (const action of ["fit-a4", "export-images", "split", "compress"]) {
      expect(await appMenuItemEnabled(action)).toBe(false)
    }

    const closeAll = await appMenuItem("close-all")
    const actions = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-slot='dropdown-menu-content'] [data-action]",
        ),
        (node) => node.getAttribute("data-action"),
      ),
    )
    await closeAppMenu(closeAll)

    expect(actions).not.toContain("print")
    expect(actions).not.toContain("export")
    const closeIndex = actions.indexOf("close-all")
    const settingsIndex = actions.indexOf("settings")
    expect(actions.slice(closeIndex + 1, settingsIndex)).toEqual([
      "fit-a4",
      "export-images",
      "split",
      "compress",
    ])
  })

  it("exports the selected pages at High, Medium, or Low resolution without mentioning dpi", async () => {
    await openPdfFromDisk("archive.pdf", minimalPdf(3))
    await renderedPage()
    await expect($("[data-slot='pdf-save-menu-trigger']")).not.toExist()

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

    for (const [imageFormat, resolution, expectedDpi] of [
      ["jpg", "high", 300],
      ["png", "low", 75],
    ] as const) {
      await clickAppMenuItem("export-images")
      const dialog = $("[data-testid='image-export-dialog']")
      await dialog.waitForDisplayed()
      expect((await dialog.getText()).toLowerCase()).not.toContain("dpi")
      await $(`[data-testid='image-format-${imageFormat}']`).click()
      await $(`[data-testid='image-resolution-${resolution}']`).click()
      await $("[data-testid='image-pages-input']").setValue("1-2")
      await $("[data-testid='image-export-start']").click()
      await dialog.waitForExist({ reverse: true })
      const request = await browser.execute(() => (window as ArchiveSeam).__archiveRequest)
      const options: ArchiveOptions = {
        format: "images",
        imageFormat,
        dpi: expectedDpi,
        pages: [1, 2],
      }
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

  it("keeps the split dialog warning and height steady across split modes", async () => {
    await openPdfFromDisk("outlined.pdf", outlinedPdf())
    await renderedPage()
    await browser.execute(() => {
      const seam = window as ArchiveSeam
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        exportPdfArchive: async (args, onProgress) => {
          seam.__archiveRequest = args
          onProgress({ completed: 2, total: 2 })
          return "/export/outlined.zip"
        },
      }
    })
    await clickAppMenuItem("split")
    const dialog = $("[data-testid='split-dialog']")
    await dialog.waitForDisplayed()
    await expect($("[data-testid='split-warning']")).toBeDisplayed()
    const bookmarksHeight = (await dialog.getSize()).height

    await $("[data-testid='split-mode-pages']").click()
    await expect($("[data-testid='split-warning']")).toBeDisplayed()
    expect((await dialog.getSize()).height).toBe(bookmarksHeight)

    await $("[data-testid='split-export-start']").click()
    await dialog.waitForExist({ reverse: true })
    const request = await browser.execute(() => (window as ArchiveSeam).__archiveRequest)
    expect(request?.options).toEqual({ format: "pages" })
    expect(request?.suggestedName).toBe("outlined-split.zip")
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
