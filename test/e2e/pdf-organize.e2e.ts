import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import {
  clickAppMenuItem,
  emitDrag,
  minimalPdf,
  outlinedPdf,
  pointMultiPickerAt,
  pressRedo,
  refreshApp,
  seedSettings,
  writeScratchPdf,
} from "./helpers"

const workspace = "[data-organize-workspace]"
const sidebar = `${workspace} [data-slot='app-sidebar']`

// Portrait pages for one file, landscape for the other: the assembled
// document's page shapes then say which file each page came from.
const portrait = () => writeScratchPdf("portrait.pdf", minimalPdf(2, "0 0 200 300"))
const landscape = () => writeScratchPdf("landscape.pdf", minimalPdf(3, "0 0 300 200"))

async function organizeWith(paths: string[]) {
  await $("button[aria-label='Organize pages']").click()
  await $(`${workspace} [data-slot='organize-empty-add']`).waitForDisplayed()
  await pointMultiPickerAt(paths)
  await $(`${workspace} [data-slot='organize-empty-add']`).click()
  await browser.waitUntil(
    async () => (await groupCount()) === paths.length,
    { timeout: 30_000, timeoutMsg: "the picked files never reached the board" },
  )
}

async function groupCount() {
  return (await $$(`${workspace} section[data-group-id]`).getElements()).length
}

function total() {
  return $(`${workspace} [data-slot='organize-total']`).getText()
}

/** Each slot of a file's section, by the label it reads as. */
function slotLabels(fileTitle: string) {
  return browser.execute(
    (scope: string, title: string) =>
      Array.from(
        document.querySelectorAll(
          `${scope} section[aria-label='${title}'] [data-slot-key] button[aria-label]`,
        ),
        (button) => button.getAttribute("aria-label"),
      ),
    workspace,
    fileTitle,
  )
}

function slot(label: string) {
  return $(`${workspace} [data-slot-key] button[aria-label='${label}']`)
}

describe("TFolio organize workspace", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("keeps its files while the reader switches to the viewer and back", async () => {
    await organizeWith([portrait(), landscape()])
    await expect(total()).resolves.toBe("5 pages in all")
    await expect($(`${sidebar} [data-slot='organize-files']`)).toHaveText(
      expect.stringContaining("portrait"),
    )

    await $("button[aria-label='View and edit']").click()
    await expect($(workspace)).not.toBeDisplayed()
    await expect($("[data-tab-strip]")).toBeDisplayed()

    await $("button[aria-label='Organize pages']").click()
    await expect($(workspace)).toBeDisplayed()
    expect(await groupCount()).toBe(2)
  })

  it("moves a page across files and assembles the plan's order", async () => {
    await organizeWith([portrait(), landscape()])

    // Cut a landscape page, choose the second portrait page, paste before it.
    await slot("Page 1 of landscape").click()
    await browser.keys(["Control", "x"])
    await slot("Page 2 of portrait").click()
    await browser.keys(["Control", "v"])

    await browser.waitUntil(
      async () =>
        JSON.stringify(await slotLabels("portrait")) ===
        JSON.stringify(["Page 1 of portrait", "Page 1 of landscape", "Page 2 of portrait"]),
      { timeout: 10_000, timeoutMsg: "the page never moved into the other file" },
    )
    expect(await slotLabels("landscape")).toEqual([
      "Page 2 of landscape",
      "Page 3 of landscape",
    ])

    await $(`${workspace} [data-slot='organize-assemble']`).click()
    await browser.waitUntil(
      async () =>
        (await $("[role='tab'][aria-selected='true']").getText()).includes(
          "Organized.pdf",
        ),
      { timeout: 30_000, timeoutMsg: "the assembled PDF never opened as a tab" },
    )
    await expect($(workspace)).not.toBeDisplayed()
    await expect($("[data-slot='page-status']")).toHaveAttribute(
      "aria-label",
      "Page 1 of 5",
    )

    const shapes = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-document-session][data-active='true'] [data-page-number]",
        ),
        (page) => (page.offsetWidth > page.offsetHeight ? "wide" : "tall"),
      ),
    )
    expect(shapes).toEqual(["tall", "wide", "tall", "wide", "wide"])
  })

  it("deletes, turns and inserts pages, each one undo away", async () => {
    await organizeWith([portrait()])

    await slot("Page 1 of portrait").click()
    await $(`${workspace} [data-slot='organize-delete']`).click()
    await expect(total()).resolves.toBe("1 page in all")
    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await total()) === "2 pages in all")
    await pressRedo()
    await browser.waitUntil(async () => (await total()) === "1 page in all")
    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await total()) === "2 pages in all")

    await slot("Page 2 of portrait").click()
    await $(`${workspace} [data-slot='organize-rotate']`).click()
    await expect(slot("Page 2 of portrait")).toHaveAttribute("data-rotation", "90")

    await $(`${workspace} [data-slot='organize-insert-blank']`).click()
    await expect($(`${workspace} [data-organize-blank]`)).toBeDisplayed()
    await expect(total()).resolves.toBe("3 pages in all")
  })

  it("previews the bookmarks the new PDF will carry", async () => {
    await organizeWith([writeScratchPdf("outlined.pdf", outlinedPdf()), portrait()])

    await $(`${sidebar} button[aria-label='Bookmarks']`).click()
    const outline = $(`${sidebar} nav[aria-label='Bookmarks']`)
    await expect(outline).toHaveText(expect.stringContaining("outlined"))
    await expect(outline).toHaveText(expect.stringContaining("portrait"))

    await $(`${workspace} [data-slot='organize-bookmarks']`).click()
    await $("[data-action='organize-keep-bookmarks']").click()
    await browser.keys("Escape")
    await expect(outline).toHaveText(expect.stringContaining("Second half"))
  })

  it("starts a file on an odd page with a blank only where it needs one", async () => {
    await organizeWith([writeScratchPdf("one.pdf", minimalPdf(1)), portrait()])
    await expect($(`${workspace} [data-organize-padding]`)).not.toBeExisting()

    await $(`${workspace} [data-slot='organize-smart-padding']`).click()
    await expect($(`${workspace} [data-organize-padding]`)).toBeDisplayed()
    await expect(total()).resolves.toBe("4 pages in all")
  })

  it("adds the files dropped on it rather than opening them", async () => {
    await organizeWith([portrait()])
    await emitDrag("drag-drop", { x: 600, y: 400 }, [landscape()])

    await browser.waitUntil(async () => (await groupCount()) === 2, {
      timeout: 30_000,
      timeoutMsg: "the dropped file never joined the board",
    })
    expect((await $$("[data-document-tab]").getElements()).length).toBe(0)
  })

  it("asks before a quit discards an arrangement no PDF was made of", async () => {
    await organizeWith([portrait()])
    // A real quit would end the process this spec drives.
    await browser.execute(() => {
      const app = window as Window & { __tfolioE2E?: E2eOverrides }

      app.__tfolioE2E = {
        ...app.__tfolioE2E,
        quitApp: async () => {
          document.documentElement.dataset.quitRequested = "true"
        },
      }
    })

    await clickAppMenuItem("exit")
    const prompt = $("[role='alertdialog']")
    await expect(prompt).toHaveText(
      expect.stringContaining("have not been made into a PDF yet"),
    )
    await prompt.$("button=Keep editing").click()
    await expect(prompt).not.toBeDisplayed()
    expect(
      await browser.execute(() => document.documentElement.dataset.quitRequested),
    ).toBeFalsy()
    expect(await groupCount()).toBe(1)
  })
})
