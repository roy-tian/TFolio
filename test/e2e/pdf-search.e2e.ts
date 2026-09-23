import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  openPdfFromDisk,
  refreshApp,
  seedSettings,
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

  it("interrupts an obsolete smooth reveal when Previous needs no scroll", async () => {
    const input = $("input[aria-label='Search text in current PDF']")
    const status = $("[data-slot='pdf-search-status']")
    await input.setValue("wrapped phrase")
    await expect(status).toHaveText(/^\d+ \/ 2$/, { wait: 10_000 })
    if (await status.getText() === "2 / 2") {
      await $("button[aria-label='Previous result']").click()
    }
    await expect(status).toHaveText("1 / 2")
    // Keep page 2 mounted at the viewport edge while its result remains below it.
    while (await $("button[aria-label='Zoom out']").isEnabled()) {
      await $("button[aria-label='Zoom out']").click()
    }
    for (let rung = 0; rung < 7; rung += 1) {
      await $("button[aria-label='Zoom in']").click()
    }
    await expect($("[data-slot='button-group'][aria-label^='Zoom ']"))
      .toHaveAttribute("aria-label", "Zoom 125%")
    await browser.pause(800)
    await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const view = viewer.getBoundingClientRect()
      const first = document.querySelector("[data-search-match='0']")!
      viewer.scrollTo({
        behavior: "instant",
        top: viewer.scrollTop + first.getBoundingClientRect().top - (view.top + view.height / 4),
      })
    })
    await $("[data-search-match='1']").waitForExist()

    const result = await browser.execute(async () => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const view = viewer.getBoundingClientRect()
      const first = document.querySelector<HTMLElement>("[data-search-match='0']")!
      const nextBox = document.querySelector("[data-search-match='1']")!.getBoundingClientRect()
      const nextIsOffscreen = nextBox.top >= view.bottom
      const nativeScrollTo = viewer.scrollTo.bind(viewer)

      return await new Promise<{
        nextIsOffscreen: boolean
        previousIsVisible: boolean
        reversedAt: number
        finishedAt: number
        smoothCalls: number
      }>((resolve, reject) => {
        let smoothCalls = 0
        const timeout = setTimeout(() => {
          delete (viewer as Partial<HTMLElement>).scrollTo
          reject(new Error("Next did not start a smooth reveal"))
        }, 5000)

        // Forward to the native animation, but reverse in the same task: that
        // scroll is time-based, so a loaded first frame can pass the old hit.
        Object.defineProperty(viewer, "scrollTo", {
          configurable: true,
          value: (options: ScrollToOptions) => {
            nativeScrollTo(options)
            if (options.behavior !== "smooth" || ++smoothCalls !== 1) {
              return
            }
            const oldBox = first.getBoundingClientRect()
            const previousIsVisible = oldBox.top >= view.top && oldBox.bottom <= view.bottom
            const reversedAt = viewer.scrollTop
            document.querySelector<HTMLButtonElement>("button[aria-label='Previous result']")!.click()
            setTimeout(() => {
              clearTimeout(timeout)
              delete (viewer as Partial<HTMLElement>).scrollTo
              resolve({
                nextIsOffscreen,
                previousIsVisible,
                reversedAt,
                finishedAt: viewer.scrollTop,
                smoothCalls,
              })
            }, 800)
          },
        })
        document.querySelector<HTMLButtonElement>("button[aria-label='Next result']")!.click()
      })
    })

    expect(result.nextIsOffscreen).toBe(true)
    expect(result.previousIsVisible).toBe(true)
    expect(result.smoothCalls).toBe(1)
    expect(Math.abs(result.finishedAt - result.reversedAt)).toBeLessThanOrEqual(0.5)
    await expect(status).toHaveText("1 / 2")
  })
})
