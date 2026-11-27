import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  deletePageFromSidebar,
  openPdfFromDisk,
  outlinedSearchPdf,
  pressRedo,
  refreshApp,
  seedSettings,
  sidebarPageAction,
  switchSidebarPanel,
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

  it("scrolls sidebar thumbnails and bookmarks to follow search jumps", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("outlined-search.pdf", outlinedSearchPdf(30))
    await $("[data-page-number='1'] canvas").waitForDisplayed()

    const thumbnailInView = (pageNumber: number) =>
      browser.execute(
        (scope: string, page: number) => {
          const list = document.querySelector<HTMLElement>(`${scope} [data-thumbnail-scroll-root]`)
          const button = list?.querySelector<HTMLElement>(`button[data-thumbnail-page='${page}']`)
          const cell = button?.closest("li")

          if (!list || !button || !cell) {
            return { current: false, visible: false }
          }

          const listBox = list.getBoundingClientRect()
          const cellBox = cell.getBoundingClientRect()

          return {
            current: button.getAttribute("aria-current") === "page",
            visible: cellBox.top >= listBox.top && cellBox.bottom <= listBox.bottom,
          }
        },
        activeSidebar,
        pageNumber,
      )

    const bookmarkInView = (title: string) =>
      browser.execute(
        (scope: string, label: string) => {
          const nav = document.querySelector<HTMLElement>(`${scope} nav[aria-label='Bookmarks']`)
          const button = Array.from(nav?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
            (candidate) => candidate.textContent?.trim() === label,
          )
          const row = button?.closest<HTMLElement>("[data-outline-current]")

          if (!nav || !button) {
            return { current: false, visible: false }
          }

          const navBox = nav.getBoundingClientRect()
          const rowBox = (row ?? button).getBoundingClientRect()

          return {
            current: button.getAttribute("aria-current") === "location" && row !== null,
            visible: rowBox.top >= navBox.top && rowBox.bottom <= navBox.bottom,
          }
        },
        activeSidebar,
        title,
      )

    await $("button[aria-label='Search this PDF']").click()
    const input = $("input[aria-label='Search text in current PDF']")
    const status = $("[data-slot='pdf-search-status']")
    const pageInput = $("input[aria-label='Page number']")

    await input.setValue("Chapter 25")
    await expect(status).toHaveText("1 / 1", { wait: 10_000 })
    await expect(pageInput).toHaveValue("25")
    await browser.waitUntil(
      async () => {
        const state = await thumbnailInView(25)
        return state.current && state.visible
      },
      { timeout: 10_000, timeoutMsg: "thumbnail 25 never scrolled into view on search jump" },
    )

    // Scrolling the thumbnail sidebar away and jumping again on the same page
    // still brings the jumped-to thumbnail back into view.
    await browser.execute((scope: string) => {
      document.querySelector<HTMLElement>(`${scope} [data-thumbnail-scroll-root]`)!.scrollTop = 0
    }, activeSidebar)
    expect((await thumbnailInView(25)).visible).toBe(false)

    await $("button[aria-label='Next result']").click()
    await browser.waitUntil(
      async () => (await thumbnailInView(25)).visible,
      { timeout: 10_000, timeoutMsg: "same-page search jump did not bring thumbnail 25 back" },
    )

    // Switching to bookmarks opens directly on the active chapter.
    await switchSidebarPanel("bookmarks")
    await browser.waitUntil(
      async () => {
        const state = await bookmarkInView("Chapter 25")
        return state.current && state.visible
      },
      { timeout: 10_000, timeoutMsg: "bookmark 25 was not active and visible on open" },
    )

    await input.setValue("Chapter 3 marker")
    await expect(status).toHaveText("1 / 1", { wait: 10_000 })
    await expect(pageInput).toHaveValue("3")
    await browser.waitUntil(
      async () => {
        const state = await bookmarkInView("Chapter 3")
        return state.current && state.visible
      },
      { timeout: 10_000, timeoutMsg: "bookmark 3 never followed the search jump" },
    )

    await input.setValue("Chapter 28")
    await expect(status).toHaveText("1 / 1", { wait: 10_000 })
    await expect(pageInput).toHaveValue("28")
    await browser.waitUntil(
      async () => {
        const state = await bookmarkInView("Chapter 28")
        return state.current && state.visible
      },
      { timeout: 10_000, timeoutMsg: "bookmark 28 never followed the search jump" },
    )

    // Scrolling the bookmarks list away and jumping again on the same page
    // brings the matching bookmark back into view.
    await browser.execute((scope: string) => {
      document.querySelector<HTMLElement>(`${scope} nav[aria-label='Bookmarks']`)!.scrollTop = 0
    }, activeSidebar)
    expect((await bookmarkInView("Chapter 28")).visible).toBe(false)

    await $("button[aria-label='Next result']").click()
    await browser.waitUntil(
      async () => (await bookmarkInView("Chapter 28")).visible,
      { timeout: 10_000, timeoutMsg: "same-page search jump did not bring bookmark 28 back" },
    )
  })
})
