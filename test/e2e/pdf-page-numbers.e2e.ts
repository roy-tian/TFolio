import { mkdirSync, readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { pageNumbersPreferencesStorageKey } from "../../src/lib/pageNumbers"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import { watermarkPreferencesStorageKey } from "../../src/lib/watermark"
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
        window.localStorage.removeItem(keys.pageNumbersPreferences)
        window.localStorage.removeItem(keys.watermarkPreferences)
      },
      {
        language: languageStorageKey,
        viewMode: viewModeStorageKey,
        pageNumbersPreferences: pageNumbersPreferencesStorageKey,
        watermarkPreferences: watermarkPreferencesStorageKey,
      },
    )
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

  it("hides the position control in double-sided mode and validates a range", async () => {
    await openPageNumbersDialog()

    // Single-sided offers a position; double-sided mirrors by binding instead.
    await expect($("//button[normalize-space()='Bottom centre']")).toBeDisplayed()
    await $("//button[normalize-space()='Double-sided']").click()
    await expect(
      $("//button[normalize-space()='Bottom centre']"),
    ).not.toBeDisplayed()

    // Turning off "number every page" reveals the range, and a backwards range
    // holds the apply button until it is valid. The fixture is one page, so a
    // valid range is 1–1.
    await $("[data-testid='page-numbers-all']").click()
    const from = $("[data-testid='page-numbers-from']")
    const to = $("[data-testid='page-numbers-to']")
    await from.waitForDisplayed()
    await from.setValue("5")
    await to.setValue("1")
    await expect($("[data-testid='page-numbers-apply']")).toBeDisabled()

    await from.setValue("1")
    await expect($("[data-testid='page-numbers-apply']")).toBeEnabled()
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
    await $("//button[normalize-space()='Bottom right']").click()
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
    // bottom, out of frame at the zoom a document opens at. The fit button
    // cycles, so reaching fit-height from the opening `auto` takes both rungs.
    mkdirSync("artifacts/e2e", { recursive: true })
    await $("button[aria-label='Fit width']").click()
    await $("button[aria-label='Fit height']").click()
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
