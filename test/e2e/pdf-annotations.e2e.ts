import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  dropZoneButton,
  openPdfFromDisk,
  pageInk,
  renderedPage,
  seedSettings,
  textPdf,
} from "./helpers"

describe("TFolio annotations", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("text.pdf", textPdf())
    await renderedPage()
  })

  it("highlights the selected text, and undo takes it back", async () => {
    await expect($$(".pdf-text-layer span")).not.toBeElementsArrayOfSize(0)

    const clean = await pageInk()

    await $("button[aria-label='Highlight text']").click()
    await expect($("button[aria-label='Highlight text']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    // Select a run the way a reader would: press on the text, drag out a
    // selection, let go. The press matters — letting go is only a commit when
    // the gesture began on the text, so a bare pointerup would prove nothing a
    // reader could reproduce.
    const selectedText = await browser.execute(() => {
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
    expect(selectedText).toContain("Highlight")

    await browser.execute(() => {
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })

    // The page is re-rastered by PDFium, so the ink arrives a beat after the
    // command does.
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    const highlighted = await pageInk()

    // Committing a mark clears the selection, so the tint left behind is the
    // drawn highlight rather than the browser's own.
    const stillSelected = await browser.execute(
      () => window.getSelection()?.toString() ?? "",
    )
    expect(stillSelected).toBe("")

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await pageInk()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the highlight back off the page",
    })

    // …and redo puts back exactly the mark that was there, not merely some ink.
    // Exact, because redo re-runs the same command into a deterministic render:
    // a redo that applied the command twice would stack two highlights and read
    // as a pass against any "more ink than clean" bar.
    await $("button[aria-label='Redo']").click()
    await browser.waitUntil(async () => (await pageInk()) === highlighted, {
      timeout: 15_000,
      timeoutMsg: "redo did not restore the highlight exactly",
    })
  })

  it("leaves undo and redo alone until there is something to take back", async () => {
    await expect($("button[aria-label='Undo']")).toBeDisabled()
    await expect($("button[aria-label='Redo']")).toBeDisabled()
  })

  // A selection outlives the drag that made it, and clicking a button does not
  // clear it. Committing on any release at all would mark that stale selection
  // when the reader pressed a toolbar control — so pressing Undo would *add* a
  // highlight, and then have nothing to undo.
  it("does not mark a stale selection when a toolbar button is clicked", async () => {
    const clean = await pageInk()

    // Select some text with the tool off, as a reader would to read or copy it.
    await browser.execute(() => {
      const span = document.querySelector(".pdf-text-layer span")!
      const range = document.createRange()
      range.selectNodeContents(span)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })

    // Turn the tool on, then press a toolbar button while the selection stands.
    await $("button[aria-label='Highlight text']").click()
    await $("button[aria-label='Rotate clockwise']").click()
    await browser.pause(2500)

    await expect($("button[aria-label='Undo']")).toBeDisabled()
    expect(await pageInk()).toBe(clean)
  })

  it("keeps both ends of a cross-page selection mounted until highlight commit", async () => {
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("cross-page-text.pdf", textPdf(6))
    await renderedPage()
    await $("[data-page-number='1'] .pdf-text-layer span").waitForExist({
      timeout: 15_000,
    })
    const cleanFirst = await pageInk(1)

    await $("button[aria-label='Highlight text']").click()
    await browser.execute(() => {
      const span = document.querySelector<HTMLElement>(
        "[data-page-number='1'] .pdf-text-layer span",
      )!
      const text = span.firstChild!
      const range = document.createRange()

      span.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      range.setStart(text, 0)
      range.collapse(true)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    // Let the selection-drag retention reach every page shell before the
    // programmatic scroll stands in for native selection auto-scroll.
    await browser.pause(100)

    await browser.execute(() => {
      document
        .querySelector("[data-page-number='6']")!
        .scrollIntoView({ block: "center" })
    })
    await $("[data-page-number='6'] .pdf-text-layer span").waitForExist({
      timeout: 15_000,
    })
    await expect(
      $("[data-page-number='1'] .pdf-text-layer span"),
    ).toBeExisting()
    const cleanLast = await pageInk(6)

    await browser.execute(() => {
      const first = document.querySelector<HTMLElement>(
        "[data-page-number='1'] .pdf-text-layer span",
      )!.firstChild!
      const last = document.querySelector<HTMLElement>(
        "[data-page-number='6'] .pdf-text-layer span",
      )!.firstChild!
      const range = document.createRange()
      range.setStart(first, 0)
      range.setEnd(last, last.textContent!.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })

    await browser.waitUntil(async () => (await pageInk(6)) > cleanLast, {
      timeout: 15_000,
      timeoutMsg: "the last selected page was not highlighted",
    })
    await browser.execute(() => {
      document
        .querySelector("[data-page-number='1']")!
        .scrollIntoView({ block: "center" })
    })
    await $("[data-page-number='1'] canvas").waitForExist({ timeout: 15_000 })
    await browser.waitUntil(async () => (await pageInk(1)) > cleanFirst, {
      timeout: 15_000,
      timeoutMsg: "the evicted selection start was not highlighted",
    })
  })
})
