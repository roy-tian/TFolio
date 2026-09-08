import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  openPdfFromDisk,
  seedSettings,
  wrappedSearchPdf,
} from "./helpers"

describe("TFolio PDF search", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await openPdfFromDisk("FilenameNeedle.pdf", wrappedSearchPdf())
    await $("[data-page-number='1'] canvas").waitForDisplayed()
  })

  it("searches only PDF text, including phrases wrapped across lines", async () => {
    const toolbarOrder = await browser.execute(() =>
      Array.from(
        document.querySelectorAll(
          "[data-document-session][data-active='true'] header button[aria-label]",
        ),
      ).map((button) => button.getAttribute("aria-label")),
    )
    expect(toolbarOrder).toEqual(
      expect.arrayContaining([
        "Menu",
        "Show bookmarks",
        "Save",
        "Print…",
        "Search this PDF",
        "Undo",
      ]),
    )
    expect(toolbarOrder.indexOf("Menu")).toBeLessThan(
      toolbarOrder.indexOf("Show bookmarks"),
    )
    // Search closes the group that saves and prints, and the whole group comes
    // before the history keys, which lead the tools at the other end.
    expect(toolbarOrder.indexOf("Show bookmarks")).toBeLessThan(
      toolbarOrder.indexOf("Save"),
    )
    expect(toolbarOrder.indexOf("Save")).toBeLessThan(
      toolbarOrder.indexOf("Print…"),
    )
    expect(toolbarOrder.indexOf("Print…")).toBeLessThan(
      toolbarOrder.indexOf("Search this PDF"),
    )
    expect(toolbarOrder.indexOf("Search this PDF")).toBeLessThan(
      toolbarOrder.indexOf("Undo"),
    )

    await $("button[aria-label='Search this PDF']").click()

    const search = $("[data-slot='pdf-search']")
    const input = $("input[aria-label='Search text in current PDF']")
    const status = $("[data-slot='pdf-search-status']")
    await expect(search).toBeDisplayed()
    await expect(input).toBeFocused()

    const placement = await browser.execute(() => {
      const bar = document
        .querySelector<HTMLElement>("[data-slot='pdf-search']")!
        .getBoundingClientRect()
      const title = document.querySelector("header")!.getBoundingClientRect()
      const tabs = document
        .querySelector("[role='tablist']")!
        .parentElement!.getBoundingClientRect()

      return {
        belowTitle: bar.top >= title.bottom,
        belowTabs: bar.top >= tabs.bottom,
        rightGap: Math.round(window.innerWidth - bar.right),
      }
    })
    expect(placement.belowTitle).toBe(true)
    expect(placement.belowTabs).toBe(true)
    expect(placement.rightGap).toBeLessThanOrEqual(16)

    // The file tab contains this string, but no PDF page does. A DOM-wide
    // WebView search would report it; the document command must not.
    await input.setValue("FilenameNeedle")
    await expect(status).toHaveText("No results", { wait: 10_000 })

    await input.setValue("wrapped phrase")
    await expect(status).toHaveText("1 / 2", { wait: 10_000 })

    // One result, two rectangles: the occurrence itself stays one counter step
    // even though it crosses the first page's visual line break.
    await expect($$("[data-search-match='0']")).toBeElementsArrayOfSize(2)
    await expect($$("[data-search-match='0'][data-active='true']")).toBeElementsArrayOfSize(2)

    const rendering = await browser.execute(() => ({
      // Search draws PDFium rectangles over the PDF's own glyphs; it does not
      // expose a substitute-font copy of the found text.
      highlightText: Array.from(
        document.querySelectorAll("[data-search-match]"),
      )
        .map((element) => element.textContent)
        .join(""),
      inputFont: window.getComputedStyle(
        document.querySelector<HTMLInputElement>(
          "input[aria-label='Search text in current PDF']",
        )!,
      ).fontFamily,
    }))
    expect(rendering.highlightText).toBe("")
    expect(rendering.inputFont).toContain("Geist")

    await $("button[aria-label='Next result']").click()
    await expect(status).toHaveText("2 / 2")
    await expect($("input[aria-label='Page number']")).toHaveValue("2")
    await expect($("[data-search-match='1'][data-active='true']")).toBeDisplayed()

    await $("button[aria-label='Close search']").click()
    await search.waitForDisplayed({ reverse: true })

    // Ctrl+F is claimed before WebKit can open its independent page-wide bar.
    const claimed = await browser.execute(() => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "f",
      })
      document.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(claimed).toBe(true)
    await expect($("[data-slot='pdf-search']")).toBeDisplayed()
    await expect(
      $("input[aria-label='Search text in current PDF']"),
    ).toBeFocused()
  })
})
