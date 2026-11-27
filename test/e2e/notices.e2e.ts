import { browser, expect, $, $$ } from "@wdio/globals"

import {
  activeSidebar,
  bandedPdf,
  openFileButton,
  openPdfFromDisk,
  pointPickerAt,
  refreshApp,
  seedSettings,
  sidebarPageAction,
  writeScratchPdf,
} from "./helpers"

function tabNamed(name: string) {
  return $(`//button[@role='tab'][normalize-space()='${name}']`)
}

async function cutPage(pageNumber: number) {
  await sidebarPageAction(pageNumber, "cut-pages")
}

describe("TFolio notices", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("stands a workspace refusal beside a document's own notice", async () => {
    const notPdf = writeScratchPdf(
      "not-a-pdf.txt",
      new Uint8Array(Buffer.from("not a PDF", "utf8")),
    )

    await openPdfFromDisk("notices.pdf", bandedPdf(4))
    await $(`${activeSidebar} button[data-thumbnail-page='2']`).waitForDisplayed()

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
    await $(`${activeSidebar} button[data-thumbnail-page='2']`).waitForDisplayed()
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

  it("anchors the corner above the status bar and clear of the find bar", async () => {
    await openPdfFromDisk("find.pdf", bandedPdf(2))
    await $(`${activeSidebar} button[data-thumbnail-page='1']`).waitForDisplayed()

    await cutPage(2)
    await $("[data-page-notice]").waitForDisplayed()

    const measureCorner = () =>
      browser.execute(() => {
        const corner = document
          .querySelector("[data-slot='notice-center']")!
          .getBoundingClientRect()
        const statusBar = document
          .querySelector("[data-slot='status-bar']")!
          .getBoundingClientRect()

        return {
          corner: {
            bottom: corner.bottom,
            right: corner.right,
            top: corner.top,
          },
          statusBarTop: statusBar.top,
          viewportWidth: window.innerWidth,
        }
      })

    const initial = await measureCorner()
    expect(initial.corner.bottom).toBeLessThan(initial.statusBarTop)
    expect(initial.corner.right).toBeLessThanOrEqual(initial.viewportWidth)
    expect(initial.viewportWidth - initial.corner.right).toBeLessThanOrEqual(24)

    await $("[data-slot='pdf-search-trigger']").click()
    await $("[data-slot='pdf-search']").waitForDisplayed()

    const after = await browser.execute(() => {
      const corner = document
        .querySelector("[data-slot='notice-center']")!
        .getBoundingClientRect()
      const findBar = document
        .querySelector("[data-slot='pdf-search']")!
        .getBoundingClientRect()

      return {
        cornerBottom: corner.bottom,
        cornerLeft: corner.left,
        cornerRight: corner.right,
        cornerTop: corner.top,
        findBarBottom: findBar.bottom,
        findBarLeft: findBar.left,
        findBarRight: findBar.right,
      }
    })

    expect(after.cornerTop).toBeGreaterThan(after.findBarBottom)
    expect(Math.abs(after.cornerBottom - initial.corner.bottom)).toBeLessThan(1)
    expect(Math.abs(after.cornerLeft - after.findBarLeft)).toBeLessThan(1)
    expect(Math.abs(after.cornerRight - after.findBarRight)).toBeLessThan(1)
  })

  it("keeps the corner above a modal and out of its aria-hidden sweep", async () => {
    await openPdfFromDisk("modal.pdf", bandedPdf(2))
    await $(`${activeSidebar} button[data-thumbnail-page='1']`).waitForDisplayed()

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
