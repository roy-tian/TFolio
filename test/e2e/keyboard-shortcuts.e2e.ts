import { readFileSync } from "node:fs"

import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  appMenuItem,
  closeAppMenu,
  dropZoneButton,
  openPdfFromDisk,
  pointPickerAt,
  refreshApp,
  renderedPage,
  seedSettings,
  textPdf,
  tooltipOn,
  writeScratchPdf,
} from "./helpers"

/** Several documents are mounted at once here and only one is on show, so
    every read has to name the visible session rather than the first match. */
const visible = "[data-document-session]:not([hidden])"

const tabCount = () => $$("button[role='tab']").length

async function renderedVisiblePage(fileName: string) {
  await browser.waitUntil(
    () =>
      browser.execute((css: string, expectedFileName: string) => {
        const layout = document.querySelector<HTMLElement>(
          `${css} [data-pdf-viewer-layout]`,
        )
        const page = layout?.querySelector<HTMLElement>(
          "[data-page-number='1']",
        )
        const canvas = page?.querySelector("canvas")

        return (
          layout?.getAttribute("aria-label") === expectedFileName &&
          Boolean(page && page.getClientRects().length > 0) &&
          (canvas?.width ?? 0) > 200
        )
      }, visible, fileName),
    {
      timeout: 30_000,
      timeoutMsg: `${fileName} page 1 never finished rendering`,
    },
  )

  await renderedPage(`${visible} [data-page-number='1']`)
}

function visibleInk() {
  return browser.execute((css: string) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `${css} [data-page-number='1'] canvas`,
    )!
    const { data } = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height)
    let ink = 0

    for (let index = 0; index < data.length; index += 4) {
      ink += 765 - data[index]! - data[index + 1]! - data[index + 2]!
    }

    return ink
  }, visible)
}

async function highlightTheText() {
  await $(`${visible} .pdf-text-layer span`).waitForExist({ timeout: 15_000 })
  // A Toggle: clicking the tool while it is active would put it away again.
  const tool = $(`${visible} button[aria-label='Highlight text']`)

  if ((await tool.getAttribute("aria-pressed")) !== "true") {
    await tool.click()
  }

  await browser.execute((css: string) => {
    const span = document.querySelector(`${css} .pdf-text-layer span`)!
    span.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }, visible)
  await browser.execute(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
}

async function markVisibleDocument(message: string) {
  const clean = await visibleInk()
  await highlightTheText()
  await browser.waitUntil(async () => (await visibleInk()) > clean, {
    timeout: 15_000,
    timeoutMsg: message,
  })

  return clean
}

/** A hint the dialog's own autofocus opened takes the first Escape for itself. */
async function closeDialog() {
  const dialog = $("[role='dialog']")

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await browser.keys("Escape")

    if (!(await dialog.isDisplayed())) {
      return
    }

    await browser.pause(300)
  }

  throw new Error("the dialog never closed")
}

describe("TFolio keyboard shortcuts", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("names each chord beside the control that answers it", async () => {
    await openPdfFromDisk("shortcuts.pdf", textPdf())
    await renderedVisiblePage("shortcuts.pdf")

    expect(await tooltipOn("[data-slot='pdf-print-trigger']")).toContain(
      "Ctrl+P",
    )
    expect(await tooltipOn("[data-slot='pdf-search-trigger']")).toContain(
      "Ctrl+F",
    )
    expect(await tooltipOn(`${visible} button[aria-label='Watermark']`)).toContain(
      "Ctrl+Alt+W",
    )
    expect(await tooltipOn(`${visible} button[aria-label^='Undo']`)).toContain(
      "Ctrl+Z",
    )

    const saveAll = await appMenuItem("save-all")
    await expect(saveAll).toHaveText(expect.stringContaining("Ctrl+Alt+S"))
    await closeAppMenu(saveAll)
  })

  it("opens the layer dialogs without starting a print", async () => {
    // ctrl+alt+p is the page numbers, not the ctrl+p that lays out the pages.
    await browser.keys(["Control", "Alt", "w"])
    await expect($("[role='dialog']")).toHaveText(
      expect.stringContaining("Document watermark"),
    )
    await closeDialog()

    await browser.keys(["Control", "Alt", "p"])
    await expect($("[role='dialog']")).toHaveText(
      expect.stringContaining("Page numbers"),
    )
    await closeDialog()
  })

  it("undoes with ctrl+z and writes the opened file with ctrl+s", async () => {
    const filePath = await openPdfFromDisk("saved-by-key.pdf", textPdf())
    await renderedVisiblePage("saved-by-key.pdf")
    const original = readFileSync(filePath)

    const clean = await markVisibleDocument("the highlight never reached the page")

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await visibleInk()) === clean, {
      timeout: 15_000,
      timeoutMsg: "ctrl+z never took the highlight back",
    })

    await markVisibleDocument("the second highlight never reached the page")
    await browser.keys(["Control", "s"])
    await browser.waitUntil(
      () => Promise.resolve(!readFileSync(filePath).equals(original)),
      { timeout: 20_000, timeoutMsg: "ctrl+s never rewrote the file" },
    )
  })

  it("creates with ctrl+n and opens with ctrl+o", async () => {
    const opened = await tabCount()

    await browser.keys(["Control", "n"])
    await browser.waitUntil(async () => (await tabCount()) === opened + 1, {
      timeout: 20_000,
      timeoutMsg: "ctrl+n opened no tab",
    })
    await expect(
      $("//button[@role='tab'][contains(., 'Untitled')]"),
    ).toBeExisting()

    await pointPickerAt(writeScratchPdf("opened-by-key.pdf", textPdf()))
    await browser.keys(["Control", "o"])
    await browser.waitUntil(async () => (await tabCount()) === opened + 2, {
      timeout: 20_000,
      timeoutMsg: "ctrl+o opened no tab",
    })
  })

  it("writes every savable document with ctrl+alt+s", async () => {
    // A reload closes what the tests above opened, leaving these two alone.
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })

    const first = await openPdfFromDisk("first.pdf", textPdf())
    await renderedVisiblePage("first.pdf")
    const firstBytes = readFileSync(first)
    await markVisibleDocument("no mark on the first document")

    const second = await openPdfFromDisk("second.pdf", textPdf())
    await renderedVisiblePage("second.pdf")
    const secondBytes = readFileSync(second)
    await markVisibleDocument("no mark on the second document")

    // One chord reaches the tab behind the one on screen too.
    await browser.keys(["Control", "Alt", "s"])
    await browser.waitUntil(
      () =>
        Promise.resolve(
          !readFileSync(first).equals(firstBytes) &&
            !readFileSync(second).equals(secondBytes),
        ),
      { timeout: 25_000, timeoutMsg: "ctrl+alt+s left a file unwritten" },
    )
  })
})
