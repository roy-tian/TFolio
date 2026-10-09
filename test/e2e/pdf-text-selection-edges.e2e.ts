import { $, $$, browser, expect } from "@wdio/globals"

import { dropZoneButton, fragmentedTextPdf, openPdfFromDisk, refreshApp, renderedPage, seedSettings, shortLastLinePdf, textPdf } from "./helpers"
import { calibratePointer, pointer } from "./nativePointer"

type ProbeWindow = Window & { __selectionSettled?: boolean }

async function prepare(pdf: Buffer) {
  await seedSettings({ ui: { language: "en", viewMode: "single" } })
  await refreshApp()
  await dropZoneButton().waitForExist()
  await openPdfFromDisk("selection-edges.pdf", pdf)
  await renderedPage()
  await $("button[aria-label='Fit page']").click()
  await $(".pdf-text-layer span").waitForExist()
}

async function settleSelection() {
  await browser.execute(() => {
    const page = window as ProbeWindow
    page.__selectionSettled = false
    requestAnimationFrame(() => requestAnimationFrame(() => { page.__selectionSettled = true }))
  })
  await browser.waitUntil(() => browser.execute(() => (window as ProbeWindow).__selectionSettled))
}

describe("TFolio selection edge regressions", () => {
  it("stays at the short final line when dragged down into its right margin", async () => {
    await prepare(shortLastLinePdf())
    const offset = await calibratePointer()
    const boxes = await browser.execute(() => [...document.querySelectorAll(".pdf-text-layer span")].map(span => {
      const { left, right, top, bottom } = span.getBoundingClientRect()
      return { left, right, top, bottom, text: span.textContent }
    }))
    const last = boxes.find(box => box.text === "End")!
    expect(last).toBeDefined()
    pointer({ x: last.left + 1 + offset.x, y: (last.top + last.bottom) / 2 + offset.y })
    pointer({ down: true })
    try {
      const x = Math.max(...boxes.map(box => box.right)) - 4 + offset.x
      for (const y of [last.bottom - 1, last.bottom + 1, last.bottom + 5, last.bottom + 20, last.bottom - 1]) {
        pointer({ x, y: y + offset.y })
        await settleSelection()
        expect(await browser.execute(() => window.getSelection()?.focusNode?.textContent)).toBe("End")
        expect(await browser.execute(() => window.getSelection()?.toString())).toBe("End")
      }
    } finally {
      pointer({ down: false })
    }
  })

  it("uses resolved bidi carets for Arabic-Indic digits, including the offscreen fallback", async () => {
    await prepare(textPdf())
    const offset = await calibratePointer()
    // Test the WebView's bidi layout independently of PDF font extraction.
    // Preserve the PDF run's box so the registered geometry remains valid.
    const box = await browser.execute(() => {
      const span = document.querySelector<HTMLElement>(".pdf-text-layer span")!
      const original = span.getBoundingClientRect()
      span.textContent = "١٢٣"
      const changed = span.getBoundingClientRect()
      const matrix = new DOMMatrix(span.style.transform)
      span.style.transform = `scale(${matrix.a * original.width / changed.width}, ${matrix.d})`
      const { left, right, top, bottom } = span.getBoundingClientRect()
      return { left, right, top, bottom }
    })
    for (const fallback of [false, true]) {
      if (fallback) {
        // Refresh at the next test restores these test-only method overrides.
        await browser.execute(() => {
          Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: () => null })
          Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => null })
        })
      }
      pointer({ x: box.left + 1 + offset.x, y: (box.top + box.bottom) / 2 + offset.y })
      pointer({ down: true })
      try {
        pointer({ x: box.right - 1 + offset.x, y: (box.top + box.bottom) / 2 + offset.y })
        await settleSelection()
        expect(await browser.execute(() => window.getSelection()?.toString())).toBe("١٢٣")
      } finally {
        pointer({ down: false })
      }
    }
    await browser.execute(() => {
      Reflect.deleteProperty(document, "caretRangeFromPoint")
      Reflect.deleteProperty(document, "caretPositionFromPoint")
    })
  })

  it("ends touch-compatible mouse events even when pointerup preceded mousedown", async () => {
    await prepare(fragmentedTextPdf(true))
    for (let index = 0; index < 4; index++) await $("button[aria-label='Zoom in']").click()
    const before = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
      const span = [...viewer.querySelectorAll<HTMLElement>(".pdf-text-layer span")].find(span => {
        const rect = span.getBoundingClientRect()
        return rect.top > 150 && rect.bottom < innerHeight - 100
      })!
      const box = span.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: box.left + 1, clientY: (box.top + box.bottom) / 2 }
      span.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerType: "touch" }))
      span.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }))
      span.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }))
      const selection = window.getSelection()!
      const before = { text: selection.toString(), offset: selection.focusOffset }
      viewer.scrollBy(0, 90)
      return before
    })
    await settleSelection()
    expect(await browser.execute(() => ({ text: window.getSelection()!.toString(), offset: window.getSelection()!.focusOffset }))).toEqual(before)
  })

  it("autoscrolls both horizontal edges and stops on release", async () => {
    await prepare(fragmentedTextPdf(true))
    for (let index = 0; index < 9; index++) await $("button[aria-label='Zoom in']").click()
    const init = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
      viewer.scrollLeft = 0
      viewer.scrollTop = 0
      const span = viewer.querySelector<HTMLElement>(".pdf-text-layer span")!
      const box = span.getBoundingClientRect()
      const bounds = viewer.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, clientX: box.left + 1, clientY: (box.top + box.bottom) / 2 }
      span.dispatchEvent(new MouseEvent("mousedown", init))
      document.dispatchEvent(new MouseEvent("mousemove", { ...init, clientX: bounds.right + 30 }))
      return { ...init, clientX: bounds.left - 30 }
    })
    try {
      await browser.waitUntil(() => browser.execute(() => document.querySelector("[data-pdf-scroll-root]")!.scrollLeft > 80))
      await browser.execute(init => document.dispatchEvent(new MouseEvent("mousemove", init)), init)
      await browser.waitUntil(() => browser.execute(() => document.querySelector("[data-pdf-scroll-root]")!.scrollLeft === 0))
    } finally {
      await browser.execute(init => document.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 })), init)
    }
    await settleSelection()
    expect(await browser.execute(() => document.querySelector("[data-pdf-scroll-root]")!.scrollLeft)).toBe(0)
  })

  it("coalesces raw mouse moves and never scans virtualized page wrappers", async () => {
    await prepare(fragmentedTextPdf(true))
    const immediate = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
      const span = viewer.querySelector<HTMLElement>(".pdf-text-layer span")!
      const box = span.getBoundingClientRect()
      const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1, clientX: box.left + 1, clientY: (box.top + box.bottom) / 2 }
      span.dispatchEvent(new MouseEvent("mousedown", init))
      let hits = 0
      let scans = 0
      const nativeHit = document.elementFromPoint.bind(document)
      const nativeQuery = viewer.querySelectorAll.bind(viewer)
      document.elementFromPoint = (x, y) => {
        hits++
        return nativeHit(x, y)
      }
      viewer.querySelectorAll = ((selector: string) => {
        if (selector === "[data-page-number]") scans++
        return nativeQuery(selector)
      }) as typeof viewer.querySelectorAll
      Object.assign(window, { __dragWork: () => ({ hits, scans }), __stopDragProbe: () => {
        document.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }))
        document.elementFromPoint = nativeHit
        viewer.querySelectorAll = nativeQuery
      } })
      for (let index = 0; index < 20; index++) {
        document.dispatchEvent(new MouseEvent("mousemove", { ...init, clientX: box.left + 2 + index }))
      }
      return { hits, scans }
    })
    try {
      expect(immediate).toEqual({ hits: 0, scans: 0 })
      await settleSelection()
      expect(await browser.execute(() => (window as Window & { __dragWork?: () => { hits: number; scans: number } }).__dragWork!()))
        .toEqual({ hits: 1, scans: 0 })
    } finally {
      await browser.execute(() => (window as Window & { __stopDragProbe?: () => void }).__stopDragProbe!())
    }
  })

  it("reuses full-page geometry when only the selected endpoint changes", async () => {
    await prepare(fragmentedTextPdf(true))
    const count = await browser.execute(() => {
      const spans = [...document.querySelectorAll<HTMLElement>(".pdf-text-layer span")]
      let reads = 0
      for (const span of spans) {
        const original = span.getBoundingClientRect.bind(span)
        span.getBoundingClientRect = () => {
          reads++
          return original()
        }
      }
      const selection = window.getSelection()!
      selection.setBaseAndExtent(spans[0].firstChild!, 0, spans[8].firstChild!, 1)
      Object.assign(window, { __spanReads: () => reads })
      return spans.length
    })
    expect(count).toBe(60)
    await settleSelection()
    expect(await browser.execute(() => (window as Window & { __spanReads?: () => number }).__spanReads!())).toBe(0)
    expect(await $$(".pdf-selection-layer span")).toHaveLength(1)
  })
})
