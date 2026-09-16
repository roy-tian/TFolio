import { browser, expect, $, $$ } from "@wdio/globals"

import {
  bandedPdf,
  openFileButton,
  openPdfFromDisk,
  pointPickerAt,
  refreshApp,
  seedSettings,
  writeScratchPdf,
} from "./helpers"

function tabNamed(name: string) {
  return $(`//button[@role='tab'][normalize-space()='${name}']`)
}

async function cutPage(pageNumber: number) {
  await $(`button[data-page-number='${pageNumber}']`).click()
  await browser.execute((page: number) => {
    const thumb = document.querySelector(`button[data-page-number='${page}']`)!
    const box = thumb.getBoundingClientRect()

    thumb.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        clientX: box.left + 20,
        clientY: box.top + 20,
      }),
    )
  }, pageNumber)
  await $("[data-action='cut-pages']").click()
}

describe("TFolio notices", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await refreshApp()
  })

  it("stands a workspace refusal beside a document's own notice", async () => {
    const notPdf = writeScratchPdf(
      "not-a-pdf.txt",
      new Uint8Array(Buffer.from("not a PDF", "utf8")),
    )

    await openPdfFromDisk("notices.pdf", bandedPdf(4))
    await $("button[data-page-number='2']").waitForDisplayed()

    // The refusal first and the cut second: the open attempt is the slow half,
    // and the notice waiting through it spends its five seconds on the harness.
    await pointPickerAt(notPdf)
    await openFileButton().click()
    await expect($("[data-notice='invalidFile']")).toHaveText(
      "Please choose a PDF, image, or Word document.",
    )

    await cutPage(2)
    await expect($("[data-page-notice]")).toHaveText("Page 2 cut")

    // The whole point of one stack: the workspace's refusal outranks nothing,
    // and the notice raised beside it is still readable.
    expect(await $$("[data-notice]")).toHaveLength(2)
    await expect($("[data-notice='invalidFile']")).toBeDisplayed()
  })

  it("holds a document's notice until its own tab is back in front", async () => {
    await openPdfFromDisk("held.pdf", bandedPdf(4))
    await $("button[data-page-number='2']").waitForDisplayed()
    await cutPage(2)
    await expect($("[data-page-notice]")).toHaveText("Page 2 cut")

    await openPdfFromDisk("other.pdf", bandedPdf(2))
    await $("[data-page-notice]").waitForDisplayed({ reverse: true })

    // Long enough that a notice left running would have expired unseen. The
    // clock belongs to the row, and a tab nobody is looking at draws none.
    await browser.pause(6_000)
    await tabNamed("held.pdf").click()
    await expect($("[data-page-notice]")).toHaveText("Page 2 cut")
  })

  it("steps the corner below the find bar while it is open", async () => {
    await openPdfFromDisk("find.pdf", bandedPdf(2))
    await $("button[data-page-number='1']").waitForDisplayed()

    const cornerTop = () =>
      browser.execute(
        () =>
          getComputedStyle(
            document.querySelector("[data-slot='notice-center']")!,
          ).top,
      )

    const closed = await cornerTop()

    await $("[data-slot='pdf-search-trigger']").click()
    await $("[data-slot='pdf-search']").waitForDisplayed()

    // The bar spans 88–128px, and the corner's own anchor is 100px, so the
    // stack has to step down or it lands across the field being typed in.
    await browser.waitUntil(
      async () => Number.parseFloat(await cornerTop()) > 128,
      { timeout: 5_000, timeoutMsg: "the corner never stepped below the find bar" },
    )
    const open = await cornerTop()

    expect(Number.parseFloat(closed)).toBe(100)
    expect(Number.parseFloat(open)).toBeGreaterThan(128)
  })

  it("keeps the corner above a modal and out of its aria-hidden sweep", async () => {
    await openPdfFromDisk("modal.pdf", bandedPdf(2))
    await $("button[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Watermark']").click()
    await $("[data-testid='watermark-dialog']").waitForDisplayed({
      timeout: 15_000,
    })

    const layering = await browser.execute(() => {
      const corner = document.querySelector("[data-slot='notice-center']")!
      const backdrop = document.querySelector("[data-slot='dialog-overlay']")

      return {
        backdropZ: backdrop ? Number(getComputedStyle(backdrop).zIndex) : null,
        cornerZ: Number(getComputedStyle(corner).zIndex),
        hidden: corner.closest("[aria-hidden='true']") !== null,
      }
    })

    // A failed apply leaves its dialog open and reports to the corner, which must
    // stay readable under it — Base UI's aria-hidden sweep spares only live regions.
    expect(layering.hidden).toBe(false)
    expect(layering.cornerZ).toBeGreaterThan(layering.backdropZ ?? 50)
  })
})
