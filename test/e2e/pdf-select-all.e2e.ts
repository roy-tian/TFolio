import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"
import type { PdfTextSpan } from "../../src/lib/pdf"

import {
  dropZoneButton,
  fragmentedTextPdf,
  mixedSizeColumnsPdf,
  openPdfFromDisk,
  pageInk,
  refreshApp,
  renderedPage,
  seedSettings,
  textPdf,
  wrappedSearchPdf,
} from "./helpers"

type ClipboardWatch = Window & { __tfolioCopied?: string | null }

/** Watches what the app hands the clipboard. The WebView refuses a read of the
    real one, and `copyPlainText` prefers this route anyway. */
async function watchClipboard() {
  await browser.execute(() => {
    const watched = window as ClipboardWatch

    watched.__tfolioCopied = null
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          watched.__tfolioCopied = text

          return Promise.resolve()
        },
      },
    })
  })
}

function copiedText() {
  return browser.execute(() => (window as ClipboardWatch).__tfolioCopied ?? null)
}

function rightClick(selector: string) {
  return browser.execute((query: string) => {
    const element = document.querySelector(query)!
    const box = element.getBoundingClientRect()

    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    )
  }, selector)
}

function nativeSelection() {
  return browser.execute(() => window.getSelection()?.toString() ?? "")
}

function selectedThumbs() {
  return browser.execute(() =>
    [...document.querySelectorAll("button[data-page-number][aria-pressed='true']")]
      .map((page) => Number(page.getAttribute("data-page-number")))
      .sort((left, right) => left - right),
  )
}

describe("TFolio select all", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("takes nothing from the interface itself", async () => {
    // Dispatched rather than typed: the bridge's typed chord runs a scripted
    // editing command no key handler can refuse, so it cannot prove consumption.
    const consumed = await browser.execute(() => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "a",
      })
      document.body.dispatchEvent(event)

      return event.defaultPrevented
    })
    expect(consumed).toBe(true)

    await browser.keys(["Control", "a"])

    await browser.waitUntil(async () => (await nativeSelection()) === "", {
      timeout: 5_000,
      timeoutMsg: "the interface was left holding a selection",
    })
  })

  it("keeps fragmented glyphs aligned and selectable at different heights", async () => {
    await openPdfFromDisk("fragmented-text.pdf", fragmentedTextPdf())
    await renderedPage()
    await $(".pdf-text-layer span").waitForExist()
    await $("button[aria-label='Fit page']").click()
    await watchClipboard()

    await browser.execute(() => {
      const page = window as Window & {
        __TAURI__: { core: { invoke: <T>(command: string, args: unknown) => Promise<T> } }
        __fragmentedSpans?: PdfTextSpan[]
      }
      const documentId = Number(document.querySelector("[data-document-session][data-active='true']")!
        .getAttribute("data-document-session"))
      void page.__TAURI__.core.invoke<PdfTextSpan[]>("extract_pdf_page_text", {
        documentId,
        pageNumber: 1,
      }).then((spans) => { page.__fragmentedSpans = spans })
    })
    await browser.waitUntil(() => browser.execute(() => Boolean(
      (window as Window & { __fragmentedSpans?: PdfTextSpan[] }).__fragmentedSpans,
    )))

    const errors = await browser.execute(() => {
      const expected = (window as Window & { __fragmentedSpans?: PdfTextSpan[] }).__fragmentedSpans!
      const page = document.querySelector("[data-page-number='1']")!
      const pageBox = page.getBoundingClientRect()
      const spans = [...page.querySelectorAll(".pdf-text-layer span")]
      const errors = spans.map((span, index) => {
        const box = span.getBoundingClientRect()
        const target = expected[index]
        const range = document.createRange()
        range.selectNodeContents(span)
        return Math.max(
          Math.abs((box.left - pageBox.left) * 300 / pageBox.width - target.left),
          Math.abs((box.top - pageBox.top) * 400 / pageBox.height - target.top),
          Math.abs(box.height * 400 / pageBox.height - target.height),
          Math.abs(range.getBoundingClientRect().width * 300 / pageBox.width - target.width),
        )
      })
      const range = document.createRange()
      range.setStart(spans[0].firstChild!, 0)
      const last = spans[spans.length - 1].firstChild!
      range.setEnd(last, last.textContent!.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return { count: spans.length, expected: expected.length, max: Math.max(...errors) }
    })
    expect(errors.count).toBe(errors.expected)
    expect(errors.count).toBeGreaterThan(40)
    expect(errors.max).toBeLessThan(0.5)

    // Native Ctrl+C bypasses the clipboard seam; the page menu exercises the
    // same selected text through the app's observable copy path.
    await rightClick(".pdf-text-layer span")
    const copyItem = $("[data-action='copy-text']")
    await copyItem.waitForDisplayed()
    await copyItem.click()
    await browser.waitUntil(async () => (await copiedText()) !== null)
    expect((await copiedText())!.replaceAll(/\s/g, "")).toBe("Selectable".repeat(6))
  })

  it("keeps body lines separate beside another column's larger heading", async () => {
    await openPdfFromDisk("mixed-size-columns.pdf", mixedSizeColumnsPdf())
    await renderedPage()
    await $(".pdf-text-layer span").waitForExist()

    await browser.keys(["Control", "a"])
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelectorAll(".pdf-selection-layer span").length === 3,
    ), { timeoutMsg: "select-all merged the two body lines beside the heading" })

    await browser.keys("Escape")
    await browser.execute(() => {
      const layer = document.querySelector(".pdf-text-layer")!
      const range = document.createRange()
      range.selectNodeContents(layer)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelectorAll(".pdf-selection-layer span").length === 3,
    ), { timeoutMsg: "the native range merged the two body lines beside the heading" })
  })

  it("selects the document's text in the page views, and Esc gives it back", async () => {
    await openPdfFromDisk("select-all.pdf", textPdf(20))
    await renderedPage()
    await $(".pdf-text-layer span").waitForExist({ timeout: 15_000 })

    await browser.keys(["Control", "a"])

    await expect($("[data-pdf-viewer-layout]")).toHaveAttribute(
      "data-select-all",
      "true",
    )
    // The highlight is the app's own, one band per line; whatever the WebView
    // did with the key, it is not left holding a selection of its own.
    await $(".pdf-selection-layer span").waitForExist({ timeout: 5_000 })
    const painted = await browser.execute(
      () =>
        getComputedStyle(document.querySelector(".pdf-selection-layer span")!)
          .backgroundColor,
    )
    expect(painted).not.toBe("rgba(0, 0, 0, 0)")
    expect(await nativeSelection()).toBe("")

    await browser.keys("Escape")

    await expect($("[data-pdf-viewer-layout]")).toHaveAttribute(
      "data-select-all",
      "false",
    )
  })

  it("copies every page, including those the viewer never mounted", async () => {
    await openPdfFromDisk("copy-all.pdf", textPdf(20))
    await renderedPage()
    await watchClipboard()

    await browser.keys(["Control", "a"])
    await browser.keys(["Control", "c"])

    await browser.waitUntil(async () => (await copiedText()) !== null, {
      timeout: 30_000,
      timeoutMsg: "nothing reached the clipboard",
    })

    const copied = (await copiedText()) ?? ""
    expect(copied).toContain("Highlight me please 1")
    // Only PDFium can have supplied the last page: pages are mounted around the
    // viewport, so most of this document has no text layer to copy from.
    expect(copied).toContain("Highlight me please 20")
    await expect($$(".pdf-text-layer")).not.toBeElementsArrayOfSize(20)
  })

  // The press that picks the item must not be taken for the click that ends a
  // selection, or the menu would copy the selection it has just discarded.
  it("copies the whole document from the page's own menu", async () => {
    await openPdfFromDisk("menu-all.pdf", textPdf(20))
    await renderedPage()
    await $(".pdf-text-layer span").waitForExist({ timeout: 15_000 })
    await watchClipboard()

    await browser.keys(["Control", "a"])
    await rightClick(".pdf-text-layer span")

    const copyItem = await $("[data-action='copy-text']")
    await copyItem.waitForDisplayed({ timeout: 15_000 })
    // A select-all is the app's own, with no range a highlight could mark.
    await expect($("[data-action='highlight-text']")).not.toExist()
    await copyItem.click()

    await browser.waitUntil(async () => (await copiedText()) !== null, {
      timeout: 30_000,
      timeoutMsg: "nothing reached the clipboard",
    })
    expect((await copiedText()) ?? "").toContain("Highlight me please 20")
  })

  // A shift-click far down the document: the pages between were passed while
  // nothing was selected, so they hold no spans for the WebView to copy.
  it("copies the pages a selection runs over without spans", async () => {
    await openPdfFromDisk("span-copy.pdf", textPdf(20))
    await $("[data-page-number='1'] .pdf-text-layer span").waitForExist({ timeout: 15_000 })
    await watchClipboard()
    await browser.execute(() => {
      const text = document.querySelector("[data-page-number='1'] .pdf-text-layer span")!.firstChild!
      window.getSelection()!.setBaseAndExtent(text, 0, text, 9)
      document.querySelector("[data-page-number='10']")!.scrollIntoView({ block: "start" })
    })
    await $("[data-page-number='10'] .pdf-text-layer span").waitForExist({ timeout: 15_000 })
    const unbuilt = await browser.execute(() => {
      const selection = window.getSelection()!
      const end = document.querySelector("[data-page-number='10'] .pdf-text-layer span")!.firstChild!
      selection.setBaseAndExtent(selection.anchorNode!, selection.anchorOffset, end, 9)

      return [2, 3, 4, 5, 6, 7, 8].filter((page) =>
        !document.querySelector(`[data-page-number='${page}'] .pdf-text-layer span`))
    })
    expect(unbuilt.length).toBeGreaterThan(0)

    // Pages a blank line apart, as the whole document's copy sets them.
    const expected = [
      ...Array.from({ length: 9 }, (_, index) => `Highlight me please ${index + 1}`),
      "Highlight",
    ].join("\n\n")
    // The WebView's own copy, as a key would start it; the pages between are
    // read as the selection is made, so a later event finds them waiting.
    const copied = await browser.waitUntil(
      () => browser.execute(() => {
        const data = new DataTransfer()
        const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data })
        document.dispatchEvent(event)

        return event.defaultPrevented ? data.getData("text/plain") : ""
      }),
      { timeout: 15_000, timeoutMsg: "the copy never took over the pages without spans" },
    )
    expect(copied).toBe(expected)

    // A copy above that found a page still being read wrote the clipboard
    // late itself: clear the watch, or that write would pass for the menu's.
    await watchClipboard()
    await rightClick("[data-page-number='10'] .pdf-text-layer span")
    const copyItem = await $("[data-action='copy-text']")
    await copyItem.waitForDisplayed({ timeout: 15_000 })
    await copyItem.click()
    await browser.waitUntil(async () => (await copiedText()) !== null, {
      timeout: 15_000,
      timeoutMsg: "nothing reached the clipboard",
    })
    expect(await copiedText()).toBe(expected)
  })

  // Runs carry no line breaks; PDFium's text, which a copy follows, does.
  it("copies a page's lines apart, as PDFium reads them", async () => {
    await openPdfFromDisk("wrapped-copy.pdf", wrappedSearchPdf())
    await $("[data-page-number='1'] .pdf-text-layer span").waitForExist({ timeout: 15_000 })
    const copied = await browser.execute(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector("[data-page-number='1'] .pdf-text-layer")!)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)

      const data = new DataTransfer()
      const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data })
      document.dispatchEvent(event)

      return event.defaultPrevented ? data.getData("text/plain") : null
    })
    expect(copied).toBe("Wrapped\nphrase")
  })

  // Copied before PDFium has read the page between: waiting on it would write
  // the clipboard after the key, so the page's own spans stand in.
  it("copies a page with spans at once while PDFium still reads it", async () => {
    await openPdfFromDisk("pending-copy.pdf", textPdf(3))
    await renderedPage()
    while (await $("button[aria-label='Zoom out']").isEnabled()) {
      await $("button[aria-label='Zoom out']").click()
    }
    await browser.waitUntil(
      () => browser.execute(() => [1, 2, 3].every((page) =>
        document.querySelector(`[data-page-number='${page}'] .pdf-text-layer span`))),
      { timeout: 15_000, timeoutMsg: "the three pages never all had spans" },
    )

    // One script: no frame passes between the selection and the copy, so no
    // read of page 2 has even been queued.
    const copied = await browser.execute(() => {
      const start = document.querySelector("[data-page-number='1'] .pdf-text-layer span")!.firstChild!
      const end = document.querySelector("[data-page-number='3'] .pdf-text-layer span")!.firstChild!
      window.getSelection()!.setBaseAndExtent(start, 0, end, 9)

      const data = new DataTransfer()
      const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data })
      document.dispatchEvent(event)

      return event.defaultPrevented ? data.getData("text/plain") : null
    })
    expect(copied).toBe("Highlight me please 1\n\nHighlight me please 2\n\nHighlight")
  })

  // The selection reaches the page only after it has left the band spans
  // keep to: nothing to measure, yet the whole page is selected.
  it("paints and highlights a page selected whole before it has spans", async () => {
    await openPdfFromDisk("whole-page.pdf", textPdf(4))
    await $("[data-page-number='1'] .pdf-text-layer span").waitForExist({ timeout: 15_000 })
    await browser.execute(() => {
      const text = document.querySelector("[data-page-number='1'] .pdf-text-layer span")!.firstChild!
      window.getSelection()!.setBaseAndExtent(text, 0, text, 9)

      // Page 2 goes past the 200px spans keep to but stays within the 800px
      // a surface does, with page 3's text still in view.
      const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
      const second = document.querySelector("[data-page-number='2']")!.getBoundingClientRect()
      const third = document.querySelector("[data-page-number='3']")!.getBoundingClientRect()
      const textTop = 0.4 * third.height
      const past = Math.min(500, third.top - second.bottom + textTop)
      viewer.scrollTop += second.bottom - viewer.getBoundingClientRect().top + past
    })
    await browser.waitUntil(
      () => browser.execute(() =>
        Boolean(document.querySelector("[data-page-number='2'] canvas[data-rendered='true']")) &&
        !document.querySelector("[data-page-number='2'] .pdf-text-layer span") &&
        Boolean(document.querySelector("[data-page-number='3'] .pdf-text-layer span"))),
      { timeout: 15_000, timeoutMsg: "page 2 never stood mounted without spans" },
    )

    const clean = await pageInk(2)
    await browser.execute(() => {
      const selection = window.getSelection()!
      const end = document.querySelector("[data-page-number='3'] .pdf-text-layer span")!.firstChild!
      selection.setBaseAndExtent(selection.anchorNode!, selection.anchorOffset, end, 9)
    })
    await browser.waitUntil(
      () => browser.execute(() =>
        document.querySelectorAll("[data-page-number='2'] .pdf-selection-layer span").length > 0),
      { timeout: 5_000, timeoutMsg: "the page selected whole showed no selection" },
    )
    expect(await browser.execute(() =>
      Boolean(document.querySelector("[data-page-number='2'] .pdf-text-layer span")))).toBe(false)

    await rightClick("[data-page-number='3'] .pdf-text-layer span")
    const highlightItem = await $("[data-action='highlight-text']")
    await highlightItem.waitForDisplayed({ timeout: 15_000 })
    await highlightItem.click()
    await browser.waitUntil(async () => (await pageInk(2)) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight left out the page selected whole",
    })
  })

  it("selects every page in the thumbnail grid", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("grid-all.pdf", textPdf(4))
    await $("button[data-page-number='4']").waitForDisplayed({ timeout: 30_000 })

    await browser.keys(["Control", "a"])

    await browser.waitUntil(async () => (await selectedThumbs()).length === 4, {
      timeout: 5_000,
      timeoutMsg: "the grid never took every page",
    })

    await browser.keys("Escape")

    await browser.waitUntil(async () => (await selectedThumbs()).length === 0, {
      timeout: 5_000,
      timeoutMsg: "the grid kept its pages after Esc",
    })
  })

  it("leaves a field holding its own select-all", async () => {
    await openPdfFromDisk("field.pdf", textPdf(2))
    await renderedPage()
    await $("input[aria-label='Page number']").click()

    await browser.keys(["Control", "a"])

    const field = await browser.execute(() => {
      const input = document.activeElement as HTMLInputElement

      return {
        selected: input.value.slice(
          input.selectionStart ?? 0,
          input.selectionEnd ?? 0,
        ),
        value: input.value,
      }
    })
    expect(field.selected).toBe(field.value)
    await expect($("[data-pdf-viewer-layout]")).toHaveAttribute(
      "data-select-all",
      "false",
    )
  })
})
