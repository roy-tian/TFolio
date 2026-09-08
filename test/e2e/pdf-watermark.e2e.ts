import { mkdirSync, readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  appMenuItem,
  blankPdf,
  closeAppMenu,
  dropZoneButton,
  openPdfFromDisk,
  pagePixelFingerprint,
  renderedPage,
  seedSettings,
  tooltipOn,
} from "./helpers"

async function openWatermarkDialog() {
  await $("button[aria-label='Watermark']").click()
  await $("[data-testid='watermark-dialog']").waitForDisplayed({
    timeout: 15_000,
  })
}

async function applyWatermark(text: string, tiled = false) {
  await openWatermarkDialog()
  await $("[data-testid='watermark-text']").setValue(text)

  if (tiled) {
    await $("//button[normalize-space()='Tiled']").click()
  }

  await $("[data-testid='watermark-apply']").click()
  await $("[data-testid='watermark-dialog']").waitForDisplayed({
    reverse: true,
    timeout: 30_000,
  })
}

async function extractedText() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".pdf-text-layer span"))
      .map((span) => span.textContent ?? "")
      .join(" "),
  )
}

describe("TFolio document watermark", () => {
  beforeEach(async () => {
    // Everything else unset, the stored mark included: it outlives the suite,
    // and would otherwise carry one spec's choices into the next.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("watermark.pdf", blankPdf())
    await renderedPage()
  })

  it("applies tiled Chinese text, then undo and redo restore exact pixels", async () => {
    const clean = await pagePixelFingerprint()

    await openWatermarkDialog()

    // The field opens on this reader's own default mark, not empty.
    await expect($("[data-testid='watermark-text']")).toHaveValue("CONFIDENTIAL")
    await expect($("[data-testid='watermark-size']")).toHaveText(
      expect.stringContaining("80%"),
    )
    await $("[data-testid='watermark-text']").setValue("内部资料")

    // The preview leans the way the direction control says, so the two ends of
    // it cannot both draw the same mark.
    const previewTransform = () =>
      browser.execute(
        () =>
          getComputedStyle(
            document.querySelector<HTMLElement>(
              "[data-testid='watermark-preview']",
            )!,
          ).transform,
      )
    const ascending = await previewTransform()

    await $("//button[normalize-space()='Top-left to bottom-right']").click()
    expect(await previewTransform()).not.toBe(ascending)
    await $("//button[normalize-space()='Tiled']").click()
    await expect($("[data-testid='watermark-size']")).toHaveText(
      expect.stringContaining("30%"),
    )
    await browser.saveScreenshot("artifacts/e2e/watermark-dialog.png")

    // Exercise the size control as a reader would. Its label and current value
    // identify it without reaching into Base UI's generated ids.
    const size = await $(
      "[data-testid='watermark-size'] [data-slot='slider-thumb']",
    )
    await size.click()
    await browser.keys("ArrowLeft")

    await $("[data-testid='watermark-apply']").click()
    await $("[data-testid='watermark-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })

    await browser.waitUntil(async () => (await pagePixelFingerprint()) !== clean, {
      timeout: 30_000,
      timeoutMsg: "the watermark never reached the page",
    })
    const drawn = await pagePixelFingerprint()

    await browser.waitUntil(async () => (await extractedText()).includes("内部资料"), {
      timeout: 20_000,
      timeoutMsg: "the page text layer never picked up the watermark",
    })

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "undo did not restore the clean page",
    })

    await $("button[aria-label='Redo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === drawn, {
      timeout: 30_000,
      timeoutMsg: "redo did not restore the same watermark",
    })
  })

  it("replaces and explicitly removes a watermark as single history steps", async () => {
    const clean = await pagePixelFingerprint()

    await openWatermarkDialog()
    await $("[data-testid='watermark-text']").setValue("CANCELLED")
    await $("//button[normalize-space()='Cancel']").click()
    await expect($("button[aria-label='Undo']")).toBeDisabled()
    expect(await pagePixelFingerprint()).toBe(clean)

    await applyWatermark("ALPHA")
    await browser.waitUntil(async () => (await extractedText()).includes("ALPHA"), {
      timeout: 20_000,
    })

    await applyWatermark("BETA")
    await browser.waitUntil(async () => (await extractedText()).includes("BETA"), {
      timeout: 20_000,
    })
    expect(await extractedText()).not.toContain("ALPHA")

    // One undo returns to A, rather than removing the watermark altogether.
    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await extractedText()).includes("ALPHA"), {
      timeout: 20_000,
      timeoutMsg: "undo did not restore the replaced watermark",
    })

    await $("button[aria-label='Redo']").click()
    await browser.waitUntil(async () => (await extractedText()).includes("BETA"), {
      timeout: 20_000,
    })

    await openWatermarkDialog()
    await $("//button[normalize-space()='Remove watermark']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "explicit removal did not restore the clean page",
    })

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await extractedText()).includes("BETA"), {
      timeout: 20_000,
      timeoutMsg: "undo did not restore the explicitly removed watermark",
    })
  })

  it("applies from thumbnails and leaves the reader's own file alone", async () => {
    // Reopen a known path: the beforeEach fixture deliberately does not expose
    // its scratch path, while the file has to be proved untouched on disk.
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    const sourcePath = await openPdfFromDisk("watermark-save.pdf", blankPdf())
    await renderedPage()

    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Select page 1']").waitForDisplayed()
    const cleanThumbnail = await pagePixelFingerprint()
    const original = readFileSync(sourcePath)

    // The document-level action remains available even though drawing tools do
    // not: it acts on every page, not on a page under the pointer.
    await applyWatermark("ARCHIVE", true)
    await browser.waitUntil(
      async () => (await pagePixelFingerprint()) !== cleanThumbnail,
      { timeout: 30_000, timeoutMsg: "the thumbnail did not refresh" },
    )

    // A watermark this app can no longer lift once the file closes never gets
    // written back over the file it came from; only an exported copy carries it.
    // The title says which rule is holding the item down, since a clean document
    // and a document with no file of its own disable it too.
    const save = await appMenuItem("save")
    expect(await save.getAttribute("data-disabled")).not.toBe(null)
    expect(await tooltipOn("[data-action='save']")).toContain(
      "exported as a copy",
    )
    await closeAppMenu(save)
    expect(readFileSync(sourcePath).equals(original)).toBe(true)

    mkdirSync("artifacts/e2e", { recursive: true })
    await browser.saveScreenshot("artifacts/e2e/watermark.png")
  })
})
