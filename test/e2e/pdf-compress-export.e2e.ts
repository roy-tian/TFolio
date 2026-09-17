import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { CompressionOptions } from "../../src/lib/compressExport"
import {
  appMenuItemEnabled,
  clickAppMenuItem,
  minimalPdf,
  openPdfFromDisk,
  refreshApp,
  renderedPage,
  seedSettings,
} from "./helpers"

type CompressRequest = {
  options: CompressionOptions
  suggestedName: string
  documentId: number
}

type CompressSeam = Window & {
  __tfolioE2E?: E2eOverrides
  __compressRequest?: CompressRequest
}

// Defined inside each `browser.execute`: a callback the driver serializes
// runs in the page, where nothing from this module's scope exists.

describe("TFolio compress and save", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("disables compression on the home tab", async () => {
    expect(await appMenuItemEnabled("compress")).toBe(false)
  })

  it("exports either mode for the current document", async () => {
    await openPdfFromDisk("compress.pdf", minimalPdf(3))
    await renderedPage()

    for (const mode of ["lossless", "rasterized"] as const) {
      // The stub lives in the page; `filterLabel` is dropped because what the
      // spec asserts on is the compression the dialog asked for.
      await browser.execute(() => {
        const seam = window as CompressSeam
        seam.__compressRequest = undefined
        seam.__tfolioE2E = {
          ...seam.__tfolioE2E,
          exportCompressedPdf: async (args) => {
            const { filterLabel: _filterLabel, ...request } = args
            seam.__compressRequest = request

            return "/export/compressed.pdf"
          },
        }
      })

      await clickAppMenuItem("compress")
      await $("[data-testid='compress-dialog']").waitForDisplayed()

      // The estimate is the real backend's, not a stub: whatever it says, the
      // line settles only once the answer for these levels has landed.
      const estimate = $("[data-testid='compress-estimate']")
      await browser.waitUntil(
        async () => !(await estimate.getText()).includes("Estimating"),
        { timeout: 20_000, timeoutMsg: "the estimate never arrived" },
      )

      if (mode === "rasterized") {
        await $("[data-testid='compress-mode-rasterized']").click()
      }
      await $("[data-testid='compress-start']").click()
      await $("[data-testid='compress-dialog']").waitForExist({ reverse: true })

      const request = await browser.execute(
        () => (window as CompressSeam).__compressRequest,
      )
      expect(request?.options.mode).toBe(mode)
      expect(request?.suggestedName).toBe("compress-compressed.pdf")
      expect(request?.documentId).toBeGreaterThan(0)
    }
  })

  it("keeps a failed export open for retry", async () => {
    await openPdfFromDisk("compress.pdf", minimalPdf())
    await renderedPage()
    await browser.execute(() => {
      const seam = window as CompressSeam
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        exportCompressedPdf: async () => {
          throw new Error("disk full")
        },
      }
    })
    await clickAppMenuItem("compress")
    await browser.waitUntil(
      async () =>
        !(
          await $("[data-testid='compress-estimate']").getText()
        ).includes("Estimating"),
      { timeout: 20_000 },
    )
    await $("[data-testid='compress-start']").click()
    await expect($("[data-testid='compress-dialog'] [role='alert']")).toBeDisplayed()
    await expect($("[data-testid='compress-start']")).toBeEnabled()
    await $("[data-testid='compress-cancel']").click()
    await $("[data-testid='compress-dialog']").waitForExist({ reverse: true })
  })
})
