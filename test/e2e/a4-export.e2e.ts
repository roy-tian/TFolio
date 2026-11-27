import { existsSync } from "node:fs"
import path from "node:path"
import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  clickAppMenuItem,
  minimalPdf,
  openPdfFromDisk,
  outlinedPdf,
  pointMultiPickerAt,
  pointSaveAsAt,
  refreshApp,
  renderedPage,
  seedSettings,
  switchSidebarPanel,
  writeScratchPdf,
} from "./helpers"

const session = "[data-document-session][data-active='true']"
const saveTrigger = `${session} [data-slot='pdf-save-trigger']`

async function fitToA4(expectedTabName: string) {
  await clickAppMenuItem("fit-a4")
  await expect($("[data-testid='a4-dialog']")).toBeDisplayed()
  await $("[data-testid='a4-start']").click()
  await $("[data-testid='a4-dialog']").waitForExist({ reverse: true, timeout: 30_000 })
  await browser.waitUntil(
    async () =>
      (await $$(`//button[@role='tab'][normalize-space()='${expectedTabName}']`).length) === 1,
    { timeout: 30_000, timeoutMsg: "the unsaved A4 tab never opened" },
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

describe("TFolio fit to A4", () => {
  beforeEach(async () => {
    await seedSettings({
      organize: { smartPadding: true },
      ui: { language: "en", viewMode: "single" },
    })
    await refreshApp()
  })

  it("fits every page onto A4 in a new unsaved tab while keeping the original, then lets the reader save manually", async () => {
    const own = await openPdfFromDisk("small.pdf", minimalPdf(2, "0 0 200 200"))
    await renderedPage()
    expect(await pageShapes()).toEqual([100, 100])

    await fitToA4("small-A4.pdf")
    await browser.waitUntil(async () => (await pageShapes()).join() === "141,141", {
      timeoutMsg: "the pages never stood on A4",
    })
    expect((await $$("[data-document-tab]").getElements()).length).toBe(2)

    const a4Tab = $("//button[@role='tab'][normalize-space()='small-A4.pdf']")
    await expect(a4Tab).toHaveAttribute("aria-selected", "true")
    await expect(a4Tab.$("[aria-label='Unsaved changes']")).toBeExisting()
    await expect($("//button[@role='tab'][normalize-space()='small.pdf']")).toExist()

    // Unsaved A4 copy has no file on disk yet; toolbar save acts as Save As.
    await expect($(saveTrigger)).toHaveAttribute("data-save-as-only", "")
    await expect($(saveTrigger)).toBeEnabled()

    const destination = path.join(path.dirname(own), "small-A4.pdf")
    expect(existsSync(destination)).toBe(false)

    await pointSaveAsAt(destination)
    await $(saveTrigger).click()
    await browser.waitUntil(
      async () => !(await a4Tab.$("[aria-label='Unsaved changes']").isExisting()),
      { timeout: 15_000, timeoutMsg: "manual save never marked the A4 tab clean" },
    )
    expect(existsSync(destination)).toBe(true)

    // The original tab stayed untouched beside it.
    await $("//button[@role='tab'][normalize-space()='small.pdf']").click()
    await browser.waitUntil(async () => (await pageShapes()).join() === "100,100", {
      timeoutMsg: "the original tab did not keep its square pages",
    })
  })

  it("keeps the blanks between files and a bookmark for each", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
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

    await fitToA4("own-A4.pdf")
    await browser.waitUntil(async () => (await pageShapes()).length === 4, {
      timeoutMsg: "the blank between the files was not created",
    })
    await switchSidebarPanel("bookmarks")
    const bookmarks = $(`${activeSidebar} nav[aria-label='Bookmarks']`)
    await expect(bookmarks).toHaveText(expect.stringContaining("own.pdf"))
    await expect(bookmarks).toHaveText(expect.stringContaining("Second half"))
  })
})
