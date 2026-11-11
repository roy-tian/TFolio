import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  appMenuItem,
  clickAppMenuItem,
  closeAppMenu,
  dropZoneButton,
  highlightTheText,
  openPdfFromDisk,
  pageInk,
  pointMultiPickerAt,
  pointSaveAsAt,
  refreshApp,
  renderedPage,
  seedSettings,
  settingsHold,
  signedPdf,
  textPdf,
  tooltipOn,
  writeScratchPdf,
} from "./helpers"

const tabBadge = "[data-document-tab] [data-signatures]"
const prompt = "[data-slot='signature-prompt']"

/** Red ink on a page's canvas: the reading view's first page by default. */
function sealPixels(selector = "[data-active='true'] [data-page-number='1'] canvas") {
  return browser.execute((target: string) => {
    const canvas = document.querySelector<HTMLCanvasElement>(target)

    if (!canvas || canvas.width === 0) {
      return 0
    }

    // A `bitmaprenderer` canvas has no 2d context to read: copy it into one.
    const copy = document.createElement("canvas")
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext("2d")!
    context.drawImage(canvas, 0, 0)
    const { data } = context.getImageData(0, 0, copy.width, copy.height)
    let red = 0

    for (let index = 0; index < data.length; index += 4) {
      if (data[index]! > 200 && data[index + 1]! < 80 && data[index + 2]! < 80) {
        red += 1
      }
    }

    return red
  }, selector)
}

async function answerPrompt(action: "signatures-flatten" | "signatures-keep" | null) {
  await $(prompt).waitForDisplayed()

  if (action) {
    await $(`${prompt} [data-action='${action}']`).click()
  } else {
    await $(`//*[@data-slot='signature-prompt']//button[normalize-space()='Cancel']`).click()
  }

  await $(prompt).waitForDisplayed({ reverse: true })
}

function tabNamed(name: string) {
  return $(`//button[@role='tab'][normalize-space()='${name}']`)
}

describe("TFolio signed documents", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("marks a signed file's tab and never writes over the file", async () => {
    const sourcePath = await openPdfFromDisk("signed.pdf", signedPdf())
    const original = readFileSync(sourcePath)
    await renderedPage()

    await expect($(tabBadge)).toBeDisplayed()
    expect(await tooltipOn(tabBadge)).toBe("Contains 1 digital signature")

    // Unchanged, the copy is the signed file itself, and the tab stays on it.
    const copyPath = path.join(path.dirname(sourcePath), "copy.pdf")
    await pointSaveAsAt(copyPath)
    await clickAppMenuItem("save-as")
    await browser.waitUntil(() => Promise.resolve(existsSync(copyPath)), {
      timeout: 15_000,
      timeoutMsg: "Save As never wrote the copy",
    })
    expect(readFileSync(copyPath).equals(original)).toBe(true)
    await expect(tabNamed("signed.pdf")).toHaveAttribute("aria-selected", "true")

    await $("button[aria-label='Highlight text']").click()
    await answerPrompt("signatures-keep")
    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    const save = await appMenuItem("save")
    expect(await save.getAttribute("data-disabled")).not.toBe(null)
    expect(await tooltipOn("[data-action='save']")).toContain(
      "intact digital signatures",
    )
    await closeAppMenu(save)

    await browser.keys(["Control", "s"])
    await $("[data-notice='saveSignedOnly']").waitForDisplayed()
    expect(readFileSync(sourcePath).equals(original)).toBe(true)

    // Edited, the copy is PDFium's rewrite: the tab moves to it and may save there.
    const editedPath = path.join(path.dirname(sourcePath), "edited.pdf")
    await pointSaveAsAt(editedPath)
    await clickAppMenuItem("save-as")
    await expect(tabNamed("edited.pdf")).toHaveAttribute("aria-selected", "true")
    // The kept field went into the rewrite, where its signature no longer holds.
    await expect($(`${tabBadge}[data-signatures-broken]`)).toBeDisplayed()
    expect(await tooltipOn(tabBadge)).toBe("Contains 1 broken digital signature")
    expect(existsSync(editedPath)).toBe(true)
    expect(readFileSync(sourcePath).equals(original)).toBe(true)
  })

  it("brings a background signed tab forward from its badge", async () => {
    await openPdfFromDisk("signed.pdf", signedPdf())
    await renderedPage()
    await openPdfFromDisk("plain.pdf", textPdf())
    await expect(tabNamed("plain.pdf")).toHaveAttribute("aria-selected", "true")

    await $(tabBadge).click()
    await expect(tabNamed("signed.pdf")).toHaveAttribute("aria-selected", "true")
  })

  it("asks before a signed file is added, keeps its seal drawn in, and never saves over it", async () => {
    const signed = writeScratchPdf("signed.pdf", signedPdf())
    const original = readFileSync(signed)

    await openPdfFromDisk("own.pdf", textPdf())
    await renderedPage()
    await pointMultiPickerAt([signed])
    await $("[data-active='true'] [data-slot='pages-add-files']").click()
    await answerPrompt("signatures-flatten")

    // The added page, drawn with its seal as page content.
    await browser.waitUntil(
      async () =>
        (await sealPixels("[data-active='true'] button[data-thumbnail-page='2'] canvas")) > 0,
      { timeout: 15_000, timeoutMsg: "the added page lost the seal" },
    )

    // Its file stays as it was: a Save As over it is refused before it lands.
    await pointSaveAsAt(signed)
    await $("[data-active='true'] [data-slot='pdf-save-trigger']").click()
    await $("[data-notice='exportSigned']").waitForDisplayed({ timeout: 30_000 })
    expect(readFileSync(signed).equals(original)).toBe(true)
  })

  it("asks about each signed file added, unless the rest are given the same answer", async () => {
    const first = writeScratchPdf("first-signed.pdf", signedPdf())
    const plain = writeScratchPdf("plain.pdf", textPdf())
    const second = writeScratchPdf("second-signed.pdf", signedPdf())
    const forRest = `${prompt} [data-slot='signature-prompt-for-rest']`
    const pageCell = (pageNumber: number) =>
      $(`[data-active='true'] button[data-thumbnail-page='${pageNumber}']`)

    await openPdfFromDisk("own.pdf", textPdf())
    await renderedPage()
    await pointMultiPickerAt([first, plain, second])
    await $("[data-active='true'] [data-slot='pages-add-files']").click()

    // Named one at a time; the file with no signature is never asked about.
    await $(prompt).waitForDisplayed()
    await expect($(prompt)).toHaveText(expect.stringContaining("first-signed.pdf"))
    await expect($(forRest)).toBeDisplayed()
    await $(`${prompt} [data-action='signatures-flatten']`).click()
    await browser.waitUntil(
      async () => (await $(prompt).getText()).includes("second-signed.pdf"),
      { timeoutMsg: "the second signed file was not asked about" },
    )
    await expect($(forRest)).not.toBeExisting()
    await answerPrompt("signatures-keep")
    await pageCell(4).waitForExist({ timeout: 15_000 })

    // The rest given the first's answer: one prompt for both.
    await pointMultiPickerAt([first, second])
    await $("[data-active='true'] [data-slot='pages-add-files']").click()
    await $(prompt).waitForDisplayed()
    await $(forRest).click()
    await answerPrompt("signatures-keep")
    await pageCell(6).waitForExist({ timeout: 15_000 })
    await expect($(prompt)).not.toBeDisplayed()
  })

  it("asks before the first edit, and a flatten keeps the seal as page content", async () => {
    const sourcePath = await openPdfFromDisk("signed.pdf", signedPdf())
    const original = readFileSync(sourcePath)
    await renderedPage()
    await browser.waitUntil(async () => (await sealPixels()) > 0, {
      timeout: 15_000,
      timeoutMsg: "the seal never showed",
    })

    // Asked as the tool is picked; a cancel leaves it off and the file alone.
    const tool = $("button[aria-label='Highlight text']")
    await tool.click()
    await answerPrompt(null)
    expect(await tool.getAttribute("aria-pressed")).not.toBe("true")

    const pageMark = "[data-active='true'] [data-page-signature]"
    await $(pageMark).waitForExist()
    await browser.saveScreenshot("artifacts/e2e/signatures-marks.png")

    await tool.click()
    await answerPrompt("signatures-flatten")
    await expect(tool).toHaveAttribute("aria-pressed", "true")
    await browser.waitUntil(async () => (await sealPixels()) > 0, {
      timeout: 15_000,
      timeoutMsg: "the flattened page lost its seal",
    })
    // Page content now, no longer a signature: the thumbnail mark goes.
    await $(pageMark).waitForExist({ reverse: true })

    // Answered once: the edit itself goes through without another prompt.
    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })
    expect(await $(prompt).isDisplayed()).toBe(false)

    const editedPath = path.join(path.dirname(sourcePath), "edited.pdf")
    await pointSaveAsAt(editedPath)
    await clickAppMenuItem("save-as")
    await expect(tabNamed("edited.pdf")).toHaveAttribute("aria-selected", "true")
    expect(readFileSync(editedPath).includes("/ByteRange")).toBe(false)
    await expect($(tabBadge)).not.toBeExisting()
    expect(readFileSync(sourcePath).equals(original)).toBe(true)
  })

  it("keeps the signature fields when asked, and asks only once", async () => {
    const sourcePath = await openPdfFromDisk("signed.pdf", signedPdf())
    await renderedPage()

    const tool = $("button[aria-label='Highlight text']")
    await tool.click()
    await answerPrompt("signatures-keep")
    await expect(tool).toHaveAttribute("aria-pressed", "true")

    await tool.click()
    await expect(tool).not.toHaveAttribute("aria-pressed", "true")
    await tool.click()
    await expect(tool).toHaveAttribute("aria-pressed", "true")
    expect(await $(prompt).isDisplayed()).toBe(false)

    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    // The kept field travels into the copy, where its signature no longer holds.
    const editedPath = path.join(path.dirname(sourcePath), "edited.pdf")
    await pointSaveAsAt(editedPath)
    await clickAppMenuItem("save-as")
    await expect(tabNamed("edited.pdf")).toHaveAttribute("aria-selected", "true")
    expect(readFileSync(editedPath).includes("/ByteRange")).toBe(true)
  })

  it("remembers an answer from the prompt and gives it, saying so, next time", async () => {
    await openPdfFromDisk("first.pdf", signedPdf())
    await renderedPage()

    const tool = $("button[aria-label='Highlight text']")
    await tool.click()
    await $(prompt).waitForDisplayed()
    await $(`${prompt} [data-slot='signature-prompt-remember']`).click()
    await answerPrompt("signatures-flatten")
    await expect(tool).toHaveAttribute("aria-pressed", "true")
    await settingsHold(["[signatures]", 'handling = "flatten"'])

    await openPdfFromDisk("second.pdf", signedPdf())
    // Not `renderedPage()`: with two tabs its selector can find the hidden one.
    await expect(tabNamed("second.pdf")).toHaveAttribute("aria-selected", "true")
    await $("[data-active='true'] button[aria-label='Highlight text']").click()
    await $("[data-notice='signaturesFlattenedAsSet']").waitForDisplayed()
    expect(await $(prompt).isDisplayed()).toBe(false)
    await browser.waitUntil(async () => (await sealPixels()) > 0, {
      timeout: 15_000,
      timeoutMsg: "the flattened page lost its seal",
    })
  })

  it("takes the choice from Settings, where asking each time brings the prompt back", async () => {
    await seedSettings({
      signatures: { handling: "keep" },
      ui: { language: "en", viewMode: "single" },
    })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })

    await clickAppMenuItem("settings")
    await $("[role='tab'][aria-controls='settings-panel-signatures']").click()
    await expect($("[data-signature-handling='keep']")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await $("[data-signature-handling='ask']").click()
    await settingsHold(['handling = "ask"'])
    await browser.keys(["Escape"])
    await expect($("[role='dialog']")).not.toBeDisplayed()

    await openPdfFromDisk("signed.pdf", signedPdf())
    await renderedPage()
    await $("button[aria-label='Highlight text']").click()
    await answerPrompt(null)
  })
})
