import { mkdirSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  appMenuItem,
  bandedPdf,
  blankPdf,
  closeAppMenu,
  dropZoneButton,
  minimalPdf,
  openPdfFromDisk,
  pagePixelFingerprint,
  pointMultiPickerAt,
  renderedPage,
  refreshApp,
  seedSettings,
  tooltipOn,
  pressRedo,
  writeScratchPdf,
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

async function pageExtractedText(pageNumber: number) {
  return browser.execute((page: number) =>
    Array.from(
      document.querySelectorAll(
        `[data-document-session][data-active='true'] [data-page-number='${page}'] .pdf-text-layer span`,
      ),
    )
      .map((span) => span.textContent ?? "")
      .join(" "),
  pageNumber)
}

async function chooseBlankModeAndApply(choice: "show" | "hide" | "skip") {
  await openPageNumbersDialog()
  const select = $("[data-testid='page-numbers-blank-pages']")
  await select.click()
  await $(`[data-testid='page-numbers-blank-${choice}']`).click()
  await $("[data-testid='page-numbers-apply']").click()
  await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
    reverse: true,
    timeout: 30_000,
  })
}

describe("TFolio page numbers", () => {
  beforeEach(async () => {
    // Everything else unset, the stored page-number style included: it outlives
    // the suite, and would otherwise carry one spec's choices into the next.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("page-numbers.pdf", blankPdf())
    await renderedPage()
  })

  it("numbers the page, saved only as a copy, and undo, redo and removal restore exact pixels", async () => {
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

    // Numbers alone leave the document export-only, and the reason is on the
    // menu's disabled save item.
    const save = await appMenuItem("save")
    expect(await save.getAttribute("data-disabled")).not.toBe(null)
    expect(await tooltipOn("[data-action='save']")).toContain("exported as a copy")
    await closeAppMenu(save)

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "undo did not restore the clean page",
    })

    await pressRedo()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === drawn, {
      timeout: 30_000,
      timeoutMsg: "redo did not restore the same page number",
    })

    await openPageNumbersDialog()
    await $("//button[normalize-space()='Remove page numbers']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 30_000,
      timeoutMsg: "explicit removal did not restore the clean page",
    })
  })

  it("picks the placement from one control and validates a range", async () => {
    await openPageNumbersDialog()

    // One control covers fixed and mirrored places, so the preview says which is
    // chosen: a single sheet for a fixed place, an odd and an even for mirrored.
    // With no stored style it opens on the mirrored choice.
    const preview = $("[data-testid='page-numbers-preview']")
    const automatic = $("//button[normalize-space()='Automatic']")
    const fixedCenter = $("//button[normalize-space()='Fixed center']")
    const fixedRight = $("//button[normalize-space()='Fixed right']")
    // Layout height rather than getBoundingClientRect: the dialog's zoom-in-95
    // open animation scales client rects for 100 ms after mount.
    const measureHeights = () =>
      browser.execute(() => ({
        dialog: document.querySelector<HTMLElement>(
          "[data-testid='page-numbers-dialog']",
        )!.offsetHeight,
        preview: document.querySelector<HTMLElement>(
          "[data-testid='page-numbers-preview']",
        )!.offsetHeight,
      }))

    await expect(automatic).toHaveAttribute("aria-pressed", "true")
    await browser.waitUntil(
      async () => (await preview.getText()).includes("Even pages"),
      { timeout: 15_000, timeoutMsg: "the default never showed a mirrored pair" },
    )
    const autoHeights = await measureHeights()
    expect(autoHeights.dialog).toBeGreaterThan(0)
    expect(autoHeights.preview).toBeGreaterThan(0)

    await fixedCenter.click()
    await browser.waitUntil(
      async () => (await preview.getText()).includes("Every page"),
      { timeout: 15_000, timeoutMsg: "the fixed place never went back to one sheet" },
    )
    expect(await preview.getText()).not.toContain("Even pages")
    const centerHeights = await measureHeights()
    expect(centerHeights).toEqual(autoHeights)

    await fixedRight.click()
    await expect(fixedRight).toHaveAttribute("aria-pressed", "true")
    const rightText = await preview.getText()
    expect(rightText).toContain("Every page")
    expect(rightText).not.toContain("Even pages")
    const rightHeights = await measureHeights()
    expect(rightHeights).toEqual(autoHeights)

    await automatic.click()
    await browser.waitUntil(
      async () => (await preview.getText()).includes("Even pages"),
      { timeout: 15_000, timeoutMsg: "the mirrored choice never showed a pair" },
    )
    const restoredHeights = await measureHeights()
    expect(restoredHeights).toEqual(autoHeights)

    // A backwards range holds the apply button until it is valid. The fixture
    // is one page, so a valid range is 1–1.
    const range = $("[data-testid='page-numbers-range']")
    await expect(range).toHaveValue("1-1")
    for (const invalid of ["5-1", "1-2", "1-", "1,2"]) {
      await range.setValue(invalid)
      await expect($("[data-testid='page-numbers-apply']")).toBeDisabled()
    }

    await range.setValue("1-1")
    await expect($("[data-testid='page-numbers-apply']")).toBeEnabled()

    const layout = await browser.execute(() => {
      const rect = (testId: string, field = false) => {
        const element = document.querySelector(`[data-testid='${testId}']`)!
        return (field ? element.closest("[data-slot='field']")! : element)
          .getBoundingClientRect().toJSON()
      }
      return {
        range: rect("page-numbers-range"),
        start: rect("page-numbers-start"),
        blanks: rect("page-numbers-blank-pages", true),
        smart: rect("page-numbers-smart-color", true),
        select: rect("page-numbers-blank-pages"),
        checkbox: rect("page-numbers-smart-color"),
      }
    })
    expect(Math.abs(layout.range.width - layout.start.width)).toBeLessThan(1)
    expect(Math.abs(layout.blanks.width - layout.smart.width)).toBeLessThan(1)
    expect(Math.abs(layout.blanks.top - layout.smart.top)).toBeLessThan(1)
    expect(Math.abs(layout.blanks.height - layout.smart.height)).toBeLessThan(1)
    expect(Math.abs(
      layout.select.top + layout.select.height / 2 -
      (layout.checkbox.top + layout.checkbox.height / 2),
    )).toBeLessThan(1)
    mkdirSync("artifacts/e2e", { recursive: true })
    await browser.saveScreenshot("artifacts/e2e/page-numbers-dialog.png")
  })

  for (const mode of ["hide", "skip"] as const) {
    it(`selects and remembers the blank-page ${mode} option`, async () => {
      const clean = await pagePixelFingerprint()
      await openPageNumbersDialog()
      const select = $("[data-testid='page-numbers-blank-pages']")
      const labels = {
        show: "Count and show numbers",
        hide: "Count but hide numbers",
        skip: "Skip counting",
      }
      await expect(select.$("[data-slot='select-value']")).toHaveText(labels.show)

      // Each choice replaces both old flags; returning from skip must work too.
      for (const choice of ["skip", "show", mode] as const) {
        await select.click()
        await $(`[data-testid='page-numbers-blank-${choice}']`).click()
        await expect(select.$("[data-slot='select-value']")).toHaveText(labels[choice])
      }
      await $("[data-testid='page-numbers-apply']").click()
      await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
        reverse: true,
        timeout: 30_000,
      })
      expect(await pagePixelFingerprint()).toBe(clean)

      await refreshApp()
      await dropZoneButton().waitForExist({ timeout: 30_000 })
      await openPdfFromDisk(`page-numbers-blank-${mode}.pdf`, blankPdf())
      await renderedPage()
      await openPageNumbersDialog()
      await expect(
        $("[data-testid='page-numbers-blank-pages'] [data-slot='select-value']"),
      ).toHaveText(labels[mode])
    })
  }

  it("remembers the style for the next document", async () => {
    await openPageNumbersDialog()
    // Seeded settings name no style, so the applied placement below is the *other*
    // one — which makes the reopened dialog's answer the file's, not the default's.
    const centre = $("//button[normalize-space()='Fixed center']")
    const wanted =
      (await centre.getAttribute("aria-pressed")) === "true"
        ? "Automatic"
        : "Fixed center"

    await $(`//button[normalize-space()='${wanted}']`).click()
    await $("[data-testid='page-numbers-apply']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })

    // A reload drops everything the WebView held, so the next document's dialog
    // can only open on the user-level file the backend keeps.
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("page-numbers-style.pdf", blankPdf())
    await renderedPage()
    await openPageNumbersDialog()

    await expect($(`//button[normalize-space()='${wanted}']`)).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  })

  it("stops a long run, rolling the document back and freeing the app", async () => {
    await refreshApp()
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

  it("counts and displays smart-padding blanks by the blank-page rule and restores them on undo", async () => {
    await seedSettings({
      organize: { smartPadding: true },
      ui: { language: "en", viewMode: "single" },
    })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("own.pdf", bandedPdf(1))
    await renderedPage()

    await pointMultiPickerAt([writeScratchPdf("added.pdf", bandedPdf(2))])
    await $(`${activeSidebar} [data-slot='sidebar-add-files']`).click()
    const viewerBlank = $(
      "[data-document-session][data-active='true'] [data-pdf-viewer-layout] [data-padding-after='1']",
    )
    await viewerBlank.waitForExist({ timeout: 30_000 })

    // Default: Automatic (duplex) + Count and show numbers.
    // Sheet 1 = page 1 (`— 1 —`), Sheet 2 = padding blank (`— 2 —`, bottomLeft), Sheet 3 = page 2 (`— 3 —`).
    await applyPageNumbers()
    const blankNumber = viewerBlank.$("[data-testid='padding-page-number']")
    await blankNumber.waitForExist({ timeout: 15_000 })
    await expect(blankNumber).toHaveText("— 2 —")
    await expect(blankNumber).toHaveAttribute("data-anchor", "bottomLeft")
    // Page 2 sits past page 1 and the full-height padding blank, outside the
    // text layer's viewport margin until scrolled into view.
    await browser.execute(() => {
      document
        .querySelector(
          "[data-document-session][data-active='true'] [data-page-number='2']",
        )!
        .scrollIntoView({ block: "center" })
    })
    await browser.waitUntil(
      async () => {
        const text = await pageExtractedText(2)
        return text.includes("—") && text.includes("3")
      },
      { timeout: 20_000, timeoutMsg: "page 2 never counted past the padding blank" },
    )

    // Count but hide numbers: padding blank loses its label, page 2 still prints `— 3 —`.
    await chooseBlankModeAndApply("hide")
    await browser.waitUntil(async () => !(await blankNumber.isExisting()), {
      timeout: 15_000,
      timeoutMsg: "padding blank label should hide under count-and-hide",
    })
    await browser.waitUntil(
      async () => {
        const text = await pageExtractedText(2)
        return text.includes("—") && text.includes("3")
      },
      { timeout: 20_000, timeoutMsg: "page 2 lost its number under count-and-hide" },
    )

    // Skip counting: padding blank stays bare and page 2 closes up to `— 2 —`.
    await chooseBlankModeAndApply("skip")
    await browser.waitUntil(
      async () => {
        const text = await pageExtractedText(2)
        return text.includes("—") && text.includes("2") && !text.includes("3")
      },
      { timeout: 20_000, timeoutMsg: "page 2 never shifted to 2 when skipping blanks" },
    )
    expect(await blankNumber.isExisting()).toBe(false)

    // Undoing twice returns to count-and-show with the padding blank label restored.
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(
      async () => {
        const text = await pageExtractedText(2)
        return text.includes("—") && text.includes("3")
      },
      { timeout: 20_000, timeoutMsg: "first undo never restored count-and-hide" },
    )
    await $("button[aria-label^='Undo']").click()
    await blankNumber.waitForExist({ timeout: 20_000 })
    await expect(blankNumber).toHaveText("— 2 —")
  })
})
