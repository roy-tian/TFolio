import { mkdirSync, readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import type { E2eOverrides } from "../../src/lib/e2e"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import { watermarkStorageKey } from "../../src/lib/watermark"
import {
  appMenuItem,
  blankPdf,
  closeAppMenu,
  dropZoneButton,
  minimalPdf,
  openPdfFromDisk,
  pagePixelFingerprint,
  renderedPage,
} from "./helpers"

/**
 * Holds the dialog to its defaults by standing in for the stored style, which
 * lives in a user-level file and would otherwise carry one spec's choices into
 * the next — and into the next run of the suite.
 */
async function useDefaultPageNumbersStyle() {
  await browser.execute(() => {
    const seam = window as Window & { __tfolioE2E?: E2eOverrides }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      pageNumbersPreferences: () => Promise.resolve(null),
    }
  })
}

/** Puts the real stored style back, for the one spec that is about it. */
async function useStoredPageNumbersStyle() {
  await browser.execute(() => {
    const seam = window as Window & { __tfolioE2E?: E2eOverrides }

    delete seam.__tfolioE2E?.pageNumbersPreferences
  })
}

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
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "single")
        window.localStorage.removeItem(keys.watermark)
      },
      {
        language: languageStorageKey,
        viewMode: viewModeStorageKey,
        watermark: watermarkStorageKey,
      },
    )
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await useDefaultPageNumbersStyle()
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

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "undo did not restore the clean page",
    })

    await $("button[aria-label='Redo']").click()
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
    await useStoredPageNumbersStyle()
    await openPageNumbersDialog()
    // The stored style arrives a round trip after the dialog opens, and the
    // file outlives the suite — so read what it left and apply the *other*
    // placement, which no earlier run can have set for us.
    await browser.pause(500)
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
    await useStoredPageNumbersStyle()
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
    await $("button[aria-label='Undo']").click()
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
    expect(await save.getAttribute("title")).toContain("exported as a copy")
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
