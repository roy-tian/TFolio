import { readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import {
  clickAppMenuItem,
  minimalPdf,
  openFileButton,
  openPathViaDialog,
  openPdfFromBytes,
  openPdfFromDisk,
  pageInk,
  refreshApp,
  renderedPage,
  seedSettings,
} from "./helpers"

/** A real quit would end the process this spec drives. */
async function stubQuit() {
  await browser.execute(() => {
    const app = window as Window & { __tfolioE2E?: E2eOverrides }

    app.__tfolioE2E = {
      ...app.__tfolioE2E,
      quitApp: async () => {
        document.documentElement.dataset.quitRequested = "true"
      },
    }
  })
}

function quitRequested() {
  return browser.execute(
    () => document.documentElement.dataset.quitRequested === "true",
  )
}

function prompt() {
  return $("[role='alertdialog']")
}

async function deleteFirstPage() {
  await $("button[aria-label='Delete page 1']").click()
  await $("[aria-label='Unsaved changes']").waitForExist()
}

describe("closing and quitting with unsaved work", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await refreshApp()
    await openFileButton().waitForExist({ timeout: 30_000 })
  })

  it("quits at once when nothing is unsaved", async () => {
    await openPdfFromDisk("quit-clean.pdf", minimalPdf(2))
    await stubQuit()
    await clickAppMenuItem("exit")

    await browser.waitUntil(quitRequested, {
      timeoutMsg: "a clean workspace never quit",
    })
    await expect(prompt()).not.toBeDisplayed()
  })

  it("asks before quitting over an edit and keeps editing when told to", async () => {
    await openPdfFromDisk("quit-edited.pdf", minimalPdf(2))
    await deleteFirstPage()
    await stubQuit()

    await clickAppMenuItem("exit")
    await expect(prompt()).toBeDisplayed()
    await prompt().$("button=Keep editing").click()
    await expect(prompt()).not.toBeDisplayed()
    expect(await quitRequested()).toBe(false)

    await clickAppMenuItem("exit")
    await prompt().$("button=Discard and quit").click()
    await browser.waitUntil(quitRequested, {
      timeoutMsg: "discarding never went on to quit",
    })
  })

  it("saves a document from the close prompt before closing its tab", async () => {
    const filePath = await openPdfFromDisk("close-save.pdf", minimalPdf(2))
    const original = readFileSync(filePath)
    await deleteFirstPage()

    await $("button[aria-label='Close close-save.pdf']").click()
    await prompt().$("button=Save").click()

    await browser.waitUntil(
      () => Promise.resolve(!readFileSync(filePath).equals(original)),
      { timeout: 15_000, timeoutMsg: "the prompt's save never wrote the file" },
    )
    await $("button[aria-label='Close close-save.pdf']").waitForExist({
      reverse: true,
      timeoutMsg: "the saved tab never closed",
    })
  })

  it("prepares and saves a typed Chinese note before closing", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    const filePath = await openPdfFromDisk("close-note.pdf", minimalPdf(1, "0 0 300 400"))
    await renderedPage()
    expect(await pageInk()).toBe(0)
    await $("button[aria-label='Add a note']").click()
    await browser.execute(() => {
      const page = document.querySelector("[data-page-number='1']")!
      const box = page.getBoundingClientRect()
      page.querySelector("canvas")!.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, button: 0, isPrimary: true,
        clientX: box.left + box.width * 0.3,
        clientY: box.top + box.height * 0.3,
      }))
    })
    await $("textarea[aria-label='Note text']").setValue("你好")
    await $("button[aria-label='Close close-note.pdf']").click()
    await prompt().$("button=Save").click()
    await $("button[aria-label='Close close-note.pdf']").waitForExist({ reverse: true })
    await openPathViaDialog(filePath)
    await renderedPage()
    expect(await pageInk()).toBeGreaterThan(0)
  })

  it("keeps the tab when the prompt's Save As is cancelled", async () => {
    await openPdfFromBytes("close-unbound.pdf", minimalPdf(2))
    await deleteFirstPage()
    await browser.execute(() => {
      const app = window as Window & { __tfolioE2E?: E2eOverrides }

      app.__tfolioE2E = {
        ...app.__tfolioE2E,
        exportPdf: async () => {
          document.documentElement.dataset.saveAsAsked = "true"
          return null
        },
      }
    })

    await $("button[aria-label='Close close-unbound.pdf']").click()
    await prompt().$("button=Save").click()

    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.documentElement.dataset.saveAsAsked === "true",
        ),
      { timeoutMsg: "a document with no file never asked where to save" },
    )
    await expect(prompt()).not.toBeDisplayed()
    await expect(
      $("button[aria-label='Close close-unbound.pdf']"),
    ).toBeDisplayed()
  })

  it("stops a Word conversion from its notice", async () => {
    await browser.execute(() => {
      const app = window as Window & { __tfolioE2E?: E2eOverrides }
      let refuse: (() => void) | null = null

      app.__tfolioE2E = {
        ...app.__tfolioE2E,
        cancelWordOpen: async () => {
          refuse?.()
          return true
        },
        openConvertedFromPath: () =>
          new Promise((_, reject) => {
            refuse = () => reject(new Error("stopped by the reader"))
          }),
      }
    })

    await openPathViaDialog("/e2e/letter.docx")
    const notice = $("[data-notice='wordConverting']")
    await notice.waitForDisplayed()
    await notice.$("button=Stop").click()

    await notice.waitForDisplayed({
      reverse: true,
      timeoutMsg: "the conversion notice outlived its stop",
    })
    await expect($("[data-notice='openFailed']")).not.toBeDisplayed()
  })
})
