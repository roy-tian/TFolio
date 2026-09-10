import { readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  appMenuItem,
  appMenuItemEnabled,
  clickAppMenuItem,
  closeAppMenu,
  dropZoneButton,
  openPathViaDialog,
  openPdfFromBytes,
  openPdfFromDisk,
  pageInk,
  refreshApp,
  renderedPage,
  seedSettings,
  textPdf,
} from "./helpers"

/** Selects the page's one text run and lets go, the way the reader highlights:
    the press has to land on the text for the release to commit. */
async function highlightTheText() {
  await $("button[aria-label='Highlight text']").click()

  const selected = await browser.execute(() => {
    const span = document.querySelector(".pdf-text-layer span")

    if (!span) {
      return null
    }

    span.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))

    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    return span.textContent
  })
  expect(selected).toContain("Highlight")

  await browser.execute(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
}

describe("TFolio save", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("saves annotations back over the opened file", async () => {
    const filePath = await openPdfFromDisk("source.pdf", textPdf())
    const original = readFileSync(filePath)
    await renderedPage()

    // Nothing to save yet, so the menu's save item waits.
    expect(await appMenuItemEnabled("save")).toBe(false)

    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    // A mark on the page is a change on disk waiting to happen.
    expect(await appMenuItemEnabled("save")).toBe(true)
    await clickAppMenuItem("save")

    // The proof is the file: its bytes must actually change under the save.
    await browser.waitUntil(
      () => Promise.resolve(!readFileSync(filePath).equals(original)),
      { timeout: 15_000, timeoutMsg: "the save never rewrote the file" },
    )

    const saved = readFileSync(filePath)
    expect(saved.subarray(0, 5).toString("ascii")).toBe("%PDF-")
    expect(saved.length).toBeGreaterThan(original.length)

    // …and the history is clean again, so the item goes back to waiting.
    await browser.waitUntil(
      async () => !(await appMenuItemEnabled("save")),
      { timeout: 15_000, timeoutMsg: "the save never marked the history clean" },
    )

    // The saved file has to hold the mark: reopened from the same path, the
    // page carries more ink than it did clean. Reloading first, because the
    // drop zone — the only way to the picker — exists only without a document.
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPathViaDialog(filePath)
    await renderedPage()
    expect(await pageInk()).toBeGreaterThan(clean)
  })

  it("disables save for a document opened from bytes, and leaves save as available", async () => {
    await openPdfFromBytes("bytes.pdf", textPdf())
    await renderedPage()

    expect(await appMenuItemEnabled("save")).toBe(false)

    // Even with a change to save, there is no file of its own to save over.
    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })
    expect(await appMenuItemEnabled("save")).toBe(false)

    // Saving a copy stays on offer — for this document it is the only way to
    // a file at all.
    const saveAs = await appMenuItem("save-as")
    await expect(saveAs).toHaveText(expect.stringContaining("Save as…"))
    expect(await saveAs.getAttribute("data-disabled")).toBe(null)
    await closeAppMenu(saveAs)
  })
})
