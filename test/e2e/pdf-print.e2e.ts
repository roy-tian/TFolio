import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import { minimalPdf, openPdfFromDisk, refreshApp, renderedPage, seedSettings } from "./helpers"

type PrintSeam = Window & {
  __tfolioE2E?: E2eOverrides
  __tfolioPrints?: number
  __tfolioCspViolations?: string[]
}

type SheetPage = {
  complete: boolean
  naturalWidth: number
  src: string
  transform: string
  width: string
}

/** Counts the dialog requests instead of opening one: the real dialog is the
    OS's own and holds the window until a person closes it. */
async function countPrintRequests() {
  await browser.execute(() => {
    const seam = window as PrintSeam

    seam.__tfolioPrints = 0
    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      printWindow: () => {
        seam.__tfolioPrints = (seam.__tfolioPrints ?? 0) + 1

        return Promise.resolve()
      },
    }
  })
}

async function printAndReadSheet(): Promise<SheetPage[]> {
  await countPrintRequests()
  await $("[data-slot='pdf-print-trigger']").click()
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => (window as PrintSeam).__tfolioPrints ?? 0)) >
      0,
    { timeout: 60_000, timeoutMsg: "the print dialog was never asked for" },
  )

  return browser.execute(() =>
    [
      ...document.querySelectorAll<HTMLImageElement>("[data-print-sheet] img"),
    ].map((image) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      src: image.src.slice(0, 22),
      transform: image.style.transform,
      width: image.style.width,
    })),
  )
}

describe("TFolio printing", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("print.pdf", minimalPdf(3))
    await renderedPage()

    // The sheet puts a kind of source in the document that nothing else does.
    // This build carries the production CSP, so a refusal here is a real one.
    await browser.execute(() => {
      const seam = window as PrintSeam

      seam.__tfolioCspViolations = []
      document.addEventListener("securitypolicyviolation", (event) => {
        seam.__tfolioCspViolations?.push(
          `${event.violatedDirective} ${event.blockedURI}`,
        )
      })
    })
  })

  it("lays every page out before asking for the dialog", async () => {
    const sheet = await printAndReadSheet()

    expect(sheet).toHaveLength(3)

    for (const page of sheet) {
      // Decoded, or the printer would draw a blank sheet where it sits.
      expect(page.complete).toBe(true)
      expect(page.naturalWidth).toBeGreaterThan(100)
      expect(page.src).toBe("data:image/png;base64,")
      expect(page.transform).toBe("translate(-50%, -50%) rotate(0deg)")
    }
  })

  it("puts no source on the page the CSP refuses", async () => {
    const violations = await browser.execute(
      () => (window as PrintSeam).__tfolioCspViolations ?? [],
    )

    expect(violations).toEqual([])
  })

  it("carries the reader's own rotation onto the sheet", async () => {
    await $("button[aria-label='Rotate clockwise']").click()

    const sheet = await printAndReadSheet()

    expect(sheet).toHaveLength(3)

    for (const page of sheet) {
      expect(page.transform).toBe("translate(-50%, -50%) rotate(90deg)")
      // A quarter turn is fitted into the sheet's own height, then turned back.
      expect(page.width).toBe("100cqh")
    }
  })

  it("lets the sheet go once the print is over and the reader is back", async () => {
    expect(await printAndReadSheet()).toHaveLength(3)

    const sheetImages = () =>
      browser.execute(
        () => document.querySelectorAll("[data-print-sheet] img").length,
      )

    // A press before the print has run is not the reader coming back from it.
    await browser.execute(() =>
      window.dispatchEvent(new PointerEvent("pointerdown")),
    )
    expect(await sheetImages()).toBe(3)

    await browser.execute(() => {
      window.dispatchEvent(new Event("afterprint"))
      window.dispatchEvent(new PointerEvent("pointerdown"))
    })
    await browser.waitUntil(async () => (await sheetImages()) === 0, {
      timeoutMsg: "the printed sheet outlived the print",
    })
  })
})
