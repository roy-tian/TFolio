import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import { dropZoneButton, minimalPdf, openPdfFromDisk } from "./helpers"

// The zoom listener is bound natively and non-passively, so a wheel has to be
// dispatched as a real event rather than through WebDriver's scroll action.
function wheelOverViewer(init: { ctrlKey: boolean; deltaY: number }) {
  return browser.execute((options: { ctrlKey: boolean; deltaY: number }) => {
    const viewer = document.querySelector("main")!
    const rect = viewer.getBoundingClientRect()

    viewer.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        ctrlKey: options.ctrlKey,
        deltaY: options.deltaY,
      }),
    )
  }, init)
}

describe("TFolio PDF viewer", () => {
  before(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        // The view mode persists, so drop it to start from the single view.
        window.localStorage.removeItem(keys.viewMode)
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await dropZoneButton().waitForExist()
  })

  it("starts with the isolated WDIO bridge available", async () => {
    const location = await browser.tauri.execute(() => window.location.href)

    await expect(dropZoneButton()).toExist()
    await expect(dropZoneButton()).toHaveAttribute(
      "aria-label",
      "Choose a PDF file",
    )
    expect(location).toContain("tauri")
  })

  it("rejects invalid input, renders a PDF, and exercises viewer controls", async () => {
    // A real file on disk whose path fails the PDF check at the boundary.
    await openPdfFromDisk("not-a-pdf.txt", Buffer.from("not a PDF", "utf8"))
    await expect($("[role='alert']")).toHaveText("Please choose a PDF file.")

    await openPdfFromDisk("one-page.pdf", minimalPdf())

    const firstPage = await $("[data-page-number='1']")
    await firstPage.waitForDisplayed()
    await expect($("[data-slot='page-status']")).toHaveAttribute(
      "aria-label",
      "Page 1 of 1",
    )

    const canvas = await firstPage.$("canvas")
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) > 200,
      {
        timeout: 15_000,
        timeoutMsg: "PDF page did not finish rendering through PDFium",
      },
    )

    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("99")
    await browser.keys("Enter")
    await expect(pageInput).toHaveValue("1")

    await $("button[aria-label='Show bookmarks']").click()
    await expect($("nav[aria-label='Bookmarks']")).toHaveText(
      "This document has no bookmarks.",
    )

    await $("button[aria-label='Settings']").click()
    await expect($("[role='dialog']")).toBeDisplayed()

    // The About section preserves the existing application information.
    await $("[role='tab'][aria-controls='settings-panel-about']").click()
    await expect($("#settings-panel-about")).toBeDisplayed()

    // The Appearance section switches the color theme. Selecting Light then Dark
    // proves the toggle works regardless of the operating system's default scheme
    // (under "follow system" the app may already be dark before the click).
    await $("[role='tab'][aria-controls='settings-panel-appearance']").click()
    await $("//*[@role='radio' and normalize-space()='Light']").click()
    const isDarkAfterLight = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterLight).toBe(false)

    await $("//*[@role='radio' and normalize-space()='Dark']").click()
    const isDarkAfterDark = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterDark).toBe(true)

    // …and the interface language.
    await $("#settings-language").click()
    await $(
      "//*[@role='option' and normalize-space()='Simplified Chinese']",
    ).click()

    const documentLanguage = await browser.execute(
      () => document.documentElement.lang,
    )
    expect(documentLanguage).toBe("zh-CN")
  })

  it("switches between the single, book, and thumbnail views", async () => {
    // This test both asserts the single-view default and leaves a mode behind,
    // so it clears the key itself rather than leaning on the one-time `before`.
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.removeItem(keys.viewMode)
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await openPdfFromDisk("nine-pages.pdf", minimalPdf(9))
    await $("[data-page-number='1']").waitForDisplayed()

    const toggle = (label: string) => $(`button[aria-label='${label}']`)
    const pageInput = await $("input[aria-label='Page number']")

    await expect(toggle("Single page")).toHaveAttribute("aria-pressed", "true")

    // Book view pairs from page 1, so pages 1 and 2 share a spread.
    await toggle("Book").click()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
    await $("[data-page-number='2']").waitForDisplayed()

    const spread = await browser.execute(() => {
      const rowOf = (pageNumber: number) =>
        document.querySelector(`[data-page-number='${pageNumber}']`)
          ?.parentElement

      return {
        pairsFirstTwo: rowOf(1) === rowOf(2),
        startsNewRowOnThird: rowOf(1) !== rowOf(3),
        // The trailing odd page keeps the left cell, alone in its row.
        trailingRowSize: rowOf(9)?.childElementCount,
      }
    })
    expect(spread.pairsFirstTwo).toBe(true)
    expect(spread.startsNewRowOnThird).toBe(true)
    expect(spread.trailingRowSize).toBe(1)

    // Each layout stacks to a different height, and the viewer keeps its scroll
    // offset across a switch, so the reader's page has to be sought back out.
    await toggle("Single page").click()
    await pageInput.setValue("5")
    await browser.keys("Enter")
    await browser.pause(1500)
    await expect(pageInput).toHaveValue("5")
    await toggle("Book").click()
    // Give the page tracker time to settle. It only revises the current page
    // once the new layout has mounted, so asserting right away would pass
    // against the stale value before the layout can strand it.
    await browser.pause(1500)
    await expect(pageInput).toHaveValue("5")

    // Thumbnails are navigation targets: an image, and no selectable text layer.
    await toggle("Thumbnails").click()
    const thirdThumbnail = await $("button[aria-label='Go to page 3']")
    await thirdThumbnail.waitForDisplayed()
    await expect($$(".pdf-text-layer")).toBeElementsArrayOfSize(0)

    // Clicking one drops back into the single view at that page.
    await thirdThumbnail.click()
    await expect(toggle("Single page")).toHaveAttribute("aria-pressed", "true")
    await expect(pageInput).toHaveValue("3")

    // The chosen mode outlives a reload.
    await toggle("Book").click()
    await browser.refresh()
    await dropZoneButton().waitForExist()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
  })

  it("zooms from the toolbar and from ctrl+wheel", async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "single")
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await openPdfFromDisk("two-pages.pdf", minimalPdf(2))
    await $("[data-page-number='1']").waitForDisplayed()

    // The button showing the zoom is the one that resets it, so it doubles as
    // the readout every assertion here reads.
    const zoom = () => $("button[aria-label='Actual size']")
    // The room a fit has to fill is measured off the layout itself rather than
    // recomputed from the padding the code already uses, so that a fit which
    // silently stopped filling it would fail here.
    const pageBox = () =>
      browser.execute(() => {
        const element = document.querySelector<HTMLElement>(
          "[data-page-number='1']",
        )!
        const page = element.getBoundingClientRect()
        const column = element.parentElement!
        const padding = window.getComputedStyle(column)
        const viewer = document.querySelector("main")!

        return {
          availableHeight:
            viewer.clientHeight -
            parseFloat(padding.paddingTop) -
            parseFloat(padding.paddingBottom),
          availableWidth:
            viewer.clientWidth -
            parseFloat(padding.paddingLeft) -
            parseFloat(padding.paddingRight),
          height: Math.round(page.height),
          scrollableX: viewer.scrollWidth - viewer.clientWidth,
          width: Math.round(page.width),
        }
      })

    // A document opens sized to be read, never already scrolled sideways.
    expect((await pageBox()).scrollableX).toBe(0)

    // Actual size is the page's paper size: a point is 1/72 inch against a CSS
    // pixel's 1/96, so the 200pt media box measures 200 * 96/72 on screen. A
    // point-for-pixel 200 here would be a quarter short of every other reader.
    const actualSize = (percent: number) =>
      Math.round((200 * 96 * percent) / (72 * 100))

    await zoom().click()
    await expect(zoom()).toHaveText("100%")
    expect((await pageBox()).width).toBe(actualSize(100))

    await $("button[aria-label='Zoom in']").click()
    await expect(zoom()).toHaveText("125%")
    expect((await pageBox()).width).toBe(actualSize(125))

    await $("button[aria-label='Zoom out']").click()
    await $("button[aria-label='Zoom out']").click()
    await expect(zoom()).toHaveText("75%")
    expect((await pageBox()).width).toBe(actualSize(75))

    // Each fit has to actually fit, padding aside — the whole point of the two.
    await $("button[aria-label='Fit width']").click()
    const fitted = await pageBox()
    expect(fitted.width).toBe(Math.round(fitted.availableWidth))

    // The button offers the fit that is not on, and which one *is* on is said by
    // the group rather than by a pressed state that would contradict that name.
    await expect($("button[aria-label='Fit height']")).toBeExisting()
    await expect($("[data-slot='button-group']")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("fitting width"),
    )

    await $("button[aria-label='Fit height']").click()
    const fittedTall = await pageBox()
    expect(fittedTall.height).toBe(Math.round(fittedTall.availableHeight))

    // Ctrl+wheel zooms; the same wheel without it is an ordinary scroll.
    await zoom().click()
    await expect(zoom()).toHaveText("100%")
    await wheelOverViewer({ ctrlKey: true, deltaY: -300 })
    await browser.waitUntil(async () => (await zoom().getText()) !== "100%", {
      timeout: 5_000,
      timeoutMsg: "ctrl+wheel did not zoom",
    })

    const zoomed = await zoom().getText()
    await wheelOverViewer({ ctrlKey: false, deltaY: -300 })
    await browser.pause(500)
    await expect(zoom()).toHaveText(zoomed)

    // The thumbnail grid has one width for every page and so no single scale to
    // report; the controls go away rather than sit there showing a stale figure.
    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Go to page 1']").waitForDisplayed()
    await expect($("button[aria-label='Zoom in']")).not.toBeExisting()
    await expect(zoom()).not.toBeExisting()

    // Leaving the grid brings them back, still at the zoom they were left at.
    await $("button[aria-label='Single page']").click()
    await expect(zoom()).toHaveText(zoomed)
  })

  // Landscape thumbnail rows are a fraction of a page's height. Page tracking
  // must not assume a row is tall enough to reach some fixed depth down the
  // viewer, or navigation lands on a row and the tracker reports a later one.
  it("stays on the requested page in a grid of landscape pages", async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.removeItem(keys.viewMode)
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await openPdfFromDisk("landscape.pdf", minimalPdf(40, "0 0 300 200"))
    await $("[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Go to page 1']").waitForDisplayed()

    // The grid fits as many columns as the window allows, so derive a page that
    // really does start a row rather than hard-coding one.
    const columns = await browser.execute(() => {
      const cellTop = (pageNumber: number) =>
        document
          .querySelector(`[data-page-number='${pageNumber}']`)!
          .getBoundingClientRect().top
      const firstTop = cellTop(1)
      let count = 0

      for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
        if (Math.abs(cellTop(pageNumber) - firstTop) < 1) count += 1
      }

      return count
    })

    const target = String(1 + columns * 3) // leftmost cell of the fourth row
    const pageInput = await $("input[aria-label='Page number']")

    await pageInput.setValue(target)
    await browser.keys("Enter")
    // Let the tracker settle: it revises the page only after the scroll lands,
    // so asserting straight away would pass against the pre-scroll value.
    await browser.pause(1500)
    await expect(pageInput).toHaveValue(target)
  })
})
