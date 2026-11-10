import path from "node:path"
import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import {
  activeSidebar,
  deletePageFromSidebar,
  minimalPdf,
  openPdfFromDisk,
  outlinedPdf,
  pointMultiPickerAt,
  refreshApp,
  renderedPage,
  seedSettings,
  writeScratchPdf,
} from "./helpers"

const session = "[data-document-session][data-active='true']"

/** Answers the A4 copy's dialog with `destination` and runs the real write
    behind it, through the command the e2e build keeps for this. */
async function pointA4At(destination: string) {
  await browser.execute((target: string) => {
    const seam = window as unknown as Window & {
      __tfolioE2E?: E2eOverrides
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> }
    }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      saveA4Pdf: ({ documentId, onProgress }) =>
        seam.__TAURI_INTERNALS__.invoke("save_a4_pdf_to", {
          documentId,
          onProgress,
          path: target,
        }) as ReturnType<NonNullable<E2eOverrides["saveA4Pdf"]>>,
    }
  }, destination)
}

async function saveAsA4(destination: string) {
  await pointA4At(destination)
  await $(`${session} [data-slot='pdf-save-menu-trigger']`).click()
  await $("[data-action='save-a4']").click()
  await expect($("[data-testid='a4-dialog']")).toBeDisplayed()
  await $("[data-testid='a4-save']").click()
  await browser.waitUntil(
    async () =>
      (await $$(`//button[@role='tab'][normalize-space()='${path.basename(destination)}']`)
        .length) === 1,
    { timeout: 30_000, timeoutMsg: "the tab never showed the A4 copy" },
  )
}

/** Each page's long side over its short, as the reading view lays it out. */
function pageShapes() {
  return browser.execute((scope: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(`${scope} [data-page-number]`), (page) => {
      const box = page.getBoundingClientRect()

      return Math.round((Math.max(box.width, box.height) / Math.min(box.width, box.height)) * 100)
    }),
  session)
}

describe("TFolio save as A4", () => {
  beforeEach(async () => {
    await seedSettings({
      organize: { bookmarks: true, smartPadding: true },
      ui: { language: "en", viewMode: "single" },
    })
    await refreshApp()
  })

  it("fits every page onto A4 in a new file, which the tab then shows", async () => {
    const own = await openPdfFromDisk("small.pdf", minimalPdf(2, "0 0 200 200"))
    await renderedPage()
    expect(await pageShapes()).toEqual([100, 100])

    await saveAsA4(path.join(path.dirname(own), "small-A4.pdf"))
    await browser.waitUntil(async () => (await pageShapes()).join() === "141,141", {
      timeoutMsg: "the pages never stood on A4",
    })
    expect((await $$("[data-document-tab]").getElements()).length).toBe(1)
  })

  it("opens the copy beside a document with unsaved changes, which stays", async () => {
    const own = await openPdfFromDisk("edited.pdf", minimalPdf(3))
    await renderedPage()
    await deletePageFromSidebar(1)

    await pointA4At(path.join(path.dirname(own), "edited-A4.pdf"))
    await $(`${session} [data-slot='pdf-save-menu-trigger']`).click()
    await $("[data-action='save-a4']").click()
    await expect($("[data-testid='a4-keeps-original']")).toBeDisplayed()
    await $("[data-testid='a4-save']").click()

    await browser.waitUntil(
      async () => (await $$("[data-document-tab]").getElements()).length === 2,
      { timeout: 30_000, timeoutMsg: "the copy never opened beside the document" },
    )
    await expect($("//button[@role='tab'][normalize-space()='edited-A4.pdf']")).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await expect($("//button[@role='tab'][normalize-space()='edited.pdf']")).toExist()
  })

  it("keeps the blanks between files and a bookmark for each", async () => {
    const own = await openPdfFromDisk("own.pdf", minimalPdf(1))
    await pointMultiPickerAt([writeScratchPdf("added.pdf", outlinedPdf())])
    await $(`${activeSidebar} [data-slot='sidebar-add-files']`).click()
    await browser.waitUntil(async () =>
      browser
        .execute(
          (scope: string) =>
            document.querySelectorAll(`${scope} button[data-thumbnail-page]`).length,
          activeSidebar,
        )
        .then((count) => count === 3),
    )

    await saveAsA4(path.join(path.dirname(own), "combined-A4.pdf"))
    await browser.waitUntil(async () => (await pageShapes()).length === 4, {
      timeoutMsg: "the blank between the files was not written",
    })
    await $(`${activeSidebar} button[aria-label='Bookmarks']`).click()
    const bookmarks = $(`${activeSidebar} nav[aria-label='Bookmarks']`)
    await expect(bookmarks).toHaveText(expect.stringContaining("own.pdf"))
    await expect(bookmarks).toHaveText(expect.stringContaining("Second half"))
  })
})
