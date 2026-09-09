import { mkdirSync, readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  appMenuItem,
  blankPdf,
  closeAppMenu,
  dropZoneButton,
  minimalPdf,
  openPdfFromDisk,
  pagePixelFingerprint,
  renderedPage,
  seedSettings,
  tooltipOn,
} from "./helpers"

async function openPageNumbersDialog() {
  await $("button[aria-label='Page numbers']").click()
  await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
    timeout: 15_000,
  })
}

async function applyPageNumbers() {
  await openPageNumbersDialog()
  await $("[data-testid='page-numbers-apply']").click()
  await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
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

describe("TFolio page numbers", () => {
  beforeEach(async () => {
    // Everything else unset, the stored page-number style included: it outlives
    // the suite, and would otherwise carry one spec's choices into the next.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("page-numbers.pdf", blankPdf())
    await renderedPage()
  })

  it("numbers the page, and undo and redo restore exact pixels", async () => {
    const clean = await pagePixelFingerprint()

    await applyPageNumbers()

    await browser.waitUntil(async () => (await pagePixelFingerprint()) !== clean, {
      timeout: 30_000,
      timeoutMsg: "the page number never reached the page",
    })
    const drawn = await pagePixelFingerprint()

    // Page numbers are page content, so the text layer picks up the label.
    await browser.waitUntil(
      async () => {
        const text = await extractedText()
        return text.includes("—") && text.includes("1")
      },
      { timeout: 20_000, timeoutMsg: "the text layer never picked up the number" },
    )

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "undo did not restore the clean page",
    })

    await $("button[aria-label^='Redo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === drawn, {
      timeout: 30_000,
      timeoutMsg: "redo did not restore the same page number",
    })
  })

  it("picks the placement from one control and validates a range", async () => {
    await openPageNumbersDialog()

    // One control over both fixed places and the mirrored one, so the preview
    // is what says which of them the reader has landed on: a single sheet for
    // a fixed place, an odd and an even one for the mirrored choice.
    const preview = $("[data-testid='page-numbers-preview']")
    await $("//button[normalize-space()='Automatic']").click()
    await browser.waitUntil(
      async () => (await preview.getText()).includes("Even pages"),
      { timeout: 15_000, timeoutMsg: "the mirrored choice never showed a pair" },
    )

    await $("//button[normalize-space()='Fixed centre']").click()
    await browser.waitUntil(
      async () => (await preview.getText()).includes("Every page"),
      { timeout: 15_000, timeoutMsg: "the fixed place never went back to one sheet" },
    )

    // A backwards range holds the apply button until it is valid. The fixture
    // is one page, so a valid range is 1–1.
    const from = $("[data-testid='page-numbers-from']")
    const to = $("[data-testid='page-numbers-to']")
    await from.setValue("5")
    await to.setValue("1")
    await expect($("[data-testid='page-numbers-apply']")).toBeDisabled()

    await from.setValue("1")
    await expect($("[data-testid='page-numbers-apply']")).toBeEnabled()
  })

  it("remembers the style for the next document", async () => {
    await openPageNumbersDialog()
    // The seeded settings name no style, so the dialog opens on its defaults —
    // and the placement applied below is the *other* one, which is what makes
    // the reopened dialog's answer the file's rather than the default's.
    const centre = $("//button[normalize-space()='Fixed centre']")
    const wanted =
      (await centre.getAttribute("aria-pressed")) === "true"
        ? "Automatic"
        : "Fixed centre"

    await $(`//button[normalize-space()='${wanted}']`).click()
    await $("[data-testid='page-numbers-apply']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })

    // A reload drops everything this WebView held, so what the next document's
    // dialog opens on can only have come from the user-level file the backend
    // keeps. A second document also has no numbers of its own to read instead.
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("page-numbers-style.pdf", blankPdf())
    await renderedPage()
    await openPageNumbersDialog()

    await expect($(`//button[normalize-space()='${wanted}']`)).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  })

  it("replaces and explicitly removes as single history steps", async () => {
    const clean = await pagePixelFingerprint()

    await applyPageNumbers()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) !== clean, {
      timeout: 30_000,
    })
    const centred = await pagePixelFingerprint()

    // Replace the position; the page changes but stays one owned object.
    await openPageNumbersDialog()
    await $("//button[normalize-space()='Fixed right']").click()
    await $("[data-testid='page-numbers-apply']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })
    await browser.waitUntil(
      async () => (await pagePixelFingerprint()) !== centred,
      { timeout: 30_000, timeoutMsg: "the replacement never moved the number" },
    )

    // One undo returns to the centred numbers rather than removing them.
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === centred, {
      timeout: 30_000,
      timeoutMsg: "undo did not restore the replaced position",
    })

    // Explicit removal is its own step, restoring the clean page.
    await openPageNumbersDialog()
    await $("//button[normalize-space()='Remove page numbers']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "explicit removal did not restore the clean page",
    })
  })

  it("stops a long run, rolling the document back and freeing the app", async () => {
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    // Long enough that the stop always lands mid-run: this build spends about
    // ten seconds on 600 pages, and the click comes inside the first one.
    await openPdfFromDisk("page-numbers-long.pdf", minimalPdf(600))
    await renderedPage()
    const clean = await pagePixelFingerprint()

    await openPageNumbersDialog()
    await $("[data-testid='page-numbers-apply']").click()
    await $("[data-testid='page-numbers-stop']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 60_000,
    })

    // Back at the bytes it started from: the page is the one it opened as, and
    // the session owns nothing — a dialog with numbers to remove would offer to.
    expect(await pagePixelFingerprint()).toBe(clean)
    await openPageNumbersDialog()
    await expect(
      $("//button[normalize-space()='Remove page numbers']"),
    ).not.toBeExisting()
    await $("//button[normalize-space()='Cancel']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 15_000,
    })

    // And the app is free at once: the next document opens rather than queueing
    // behind a rebuild the reader has left.
    await openPdfFromDisk("page-numbers-after-stop.pdf", blankPdf())
    await $(
      "//button[@role='tab'][normalize-space()='page-numbers-after-stop.pdf']",
    ).waitForExist({ timeout: 15_000 })
  })

  it("coexists with a watermark, disables save, and leaves the file alone", async () => {
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    const sourcePath = await openPdfFromDisk(
      "page-numbers-save.pdf",
      minimalPdf(1, "0 0 300 400"),
    )
    await renderedPage()
    const original = readFileSync(sourcePath)

    // A watermark below, page numbers above — both are session page content.
    await $("button[aria-label='Watermark']").click()
    await $("[data-testid='watermark-dialog']").waitForDisplayed({ timeout: 15_000 })
    await $("[data-testid='watermark-text']").setValue("DRAFT")
    await $("[data-testid='watermark-apply']").click()
    await $("[data-testid='watermark-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })

    await applyPageNumbers()
    await browser.waitUntil(
      async () => {
        const text = await extractedText()
        return text.includes("DRAFT") && text.includes("—")
      },
      { timeout: 20_000, timeoutMsg: "both layers should reach the text layer" },
    )

    // Capture both layers with the whole page in view — the number sits at the
    // bottom, out of frame at the zoom a document opens at.
    mkdirSync("artifacts/e2e", { recursive: true })
    await $("button[aria-label='Fit page']").click()
    await browser.pause(1500)
    await browser.saveScreenshot("artifacts/e2e/page-numbers-both.png")

    // Owned page content leaves the document export-only, and the reason is on
    // the menu's disabled save item.
    const save = await appMenuItem("save")
    expect(await save.getAttribute("data-disabled")).not.toBe(null)
    expect(await tooltipOn("[data-action='save']")).toContain(
      "exported as a copy",
    )
    await closeAppMenu(save)
    expect(readFileSync(sourcePath).equals(original)).toBe(true)

    // Removing the page numbers leaves the watermark exactly in place.
    await openPageNumbersDialog()
    await $("//button[normalize-space()='Remove page numbers']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })
    await browser.waitUntil(
      async () => {
        const text = await extractedText()
        return text.includes("DRAFT") && !text.includes("—")
      },
      { timeout: 20_000, timeoutMsg: "the watermark should survive the removal" },
    )

    mkdirSync("artifacts/e2e", { recursive: true })
    await browser.saveScreenshot("artifacts/e2e/page-numbers.png")
  })
})
