import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  deletePageFromSidebar,
  openPdfFromDisk,
  pressRedo,
  refreshApp,
  seedSettings,
  sidebarPageAction,
  wrappedSearchPdf,
} from "./helpers"

describe("TFolio PDF search", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("FilenameNeedle.pdf", wrappedSearchPdf())
    await $("[data-page-number='1'] canvas").waitForDisplayed()
  })

  it("searches only PDF text, including phrases wrapped across lines", async () => {
    const toolbarOrder = await browser.execute(() =>
      Array.from(
        document.querySelectorAll(
          "[data-document-session][data-active='true'] [data-slot='toolbar'] button[aria-label]",
        ),
      ).map((button) => button.getAttribute("aria-label")),
    )
    expect(toolbarOrder).toEqual(
      expect.arrayContaining(["Undo", "Search this PDF", "Save"]),
    )
    // The history key leads the editing tools; search and the file's own
    // actions close the bar.
    expect(toolbarOrder.indexOf("Undo")).toBeLessThan(
      toolbarOrder.indexOf("Search this PDF"),
    )
    expect(toolbarOrder.indexOf("Search this PDF")).toBeLessThan(
      toolbarOrder.indexOf("Save"),
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
      const title = document
        .querySelector("[data-document-session][data-active='true'] [data-slot='toolbar']")!
        .getBoundingClientRect()
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

    // Each page holds three p's within two lines of each other. With the active
    // one in sight but off centre, stepping to its neighbour must not move.
    const viewerScrollTop = () =>
      browser.execute(
        () =>
          document.querySelector<HTMLElement>(
            "[data-document-session][data-active='true'] main",
          )!.scrollTop,
      )
    await input.setValue("p")
    await expect(status).toHaveText(/^\d+ \/ 6$/, { wait: 10_000 })
    const steppedFrom = await status.getText()
    await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const view = viewer.getBoundingClientRect()
      const active = document
        .querySelector("[data-search-match][data-active='true']")!
        .getBoundingClientRect()

      viewer.scrollTop += active.top - (view.top + view.height / 4)
    })
    const settled = await viewerScrollTop()
    await $("button[aria-label='Next result']").click()
    await expect(status).not.toHaveText(steppedFrom)
    await browser.pause(800)
    expect(await viewerScrollTop()).toBe(settled)

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

  it("refreshes search results as the sidebar edits pages", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("search-page-edits.pdf", wrappedSearchPdf())
    await $("button[aria-label='Search this PDF']").click()
    await $("input[aria-label='Search text in current PDF']").setValue("wrapped phrase")
    const status = $("[data-slot='pdf-search-status']")
    await expect(status).toHaveText("1 / 2", { wait: 10_000 })
    const previews = () => $$(`${activeSidebar} button[data-thumbnail-page]`)

    const expectResults = async (count: number) => {
      // The query itself is unchanged; wait beyond the debounce so a stale
      // count cannot make the assertion pass before the refresh lands.
      await browser.pause(1_000)
      await expect(status).toHaveText(new RegExp(`^\\d+ / ${count}$`))
    }

    await sidebarPageAction(2, "rotate-pages")
    await expect($("button[aria-label='Undo turning a page']")).toExist()
    await expectResults(2)

    await sidebarPageAction(2, "insert-blank-before")
    await expect(previews()).toBeElementsArrayOfSize(3)
    await expectResults(2)
    await deletePageFromSidebar(1)
    await expect(previews()).toBeElementsArrayOfSize(2)
    await expectResults(1)
    await $("button[aria-label^='Undo']").click()
    await expectResults(2)
    await pressRedo()
    await expectResults(1)

    // Refreshing the only match must not make an explicit Next a no-op.
    await $("button[aria-label='Next result']").click()
    await expect($("input[aria-label='Page number']")).toHaveValue("2")
    await expect($("[data-search-match='0'][data-active='true']")).toBeDisplayed()
  })

})
