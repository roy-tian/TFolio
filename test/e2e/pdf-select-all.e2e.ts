import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"
import type { PdfTextSpan } from "../../src/lib/pdf"

import {
  dropZoneButton,
  fragmentedTextPdf,
  openPdfFromDisk,
  refreshApp,
  renderedPage,
  seedSettings,
  textPdf,
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
    await copyItem.click()

    await browser.waitUntil(async () => (await copiedText()) !== null, {
      timeout: 30_000,
      timeoutMsg: "nothing reached the clipboard",
    })
    expect((await copiedText()) ?? "").toContain("Highlight me please 20")
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
