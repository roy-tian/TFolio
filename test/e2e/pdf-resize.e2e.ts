import { $, browser, expect } from "@wdio/globals"

import { MIN_PAGE_OUTPUT_SCALE } from "../../src/lib/pdf"
import { openPdfFromDisk, refreshApp, seedSettings, textPdf } from "./helpers"

type ResizeSample = {
  compositorHint: string
  fontSize: string
  pageWidth: number
  textLeft: number
  textTop: number
  textWidth: number
}

type ResizeWatch = Window & {
  __resizeSamples?: ResizeSample[]
  __resizeDone?: boolean
}

describe("PDF viewport resizing", () => {
  for (const mode of ["single", "book"] as const) {
    it(`scales ${mode} pages and selected text without repeating text layout`, async () => {
      await seedSettings({ ui: { language: "en", viewMode: mode } })
      await refreshApp()
      await openPdfFromDisk("resize-text.pdf", textPdf(4))
      await $("[data-page-number='1'] .pdf-text-layer span").waitForDisplayed()
      await $("button[aria-label='Fit page']").click()
      await $("button[aria-label='Fit width']").click()
      await browser.waitUntil(
        async () =>
          (
            await $("[data-slot='button-group'][aria-label^='Zoom ']")
              .getAttribute("aria-label")
          )?.includes("fitting width") === true,
        { timeout: 15_000, timeoutMsg: "fit width never became active" },
      )
      await browser.waitUntil(
        () =>
          browser.execute((outputScale: number) => {
            const page = document.querySelector("[data-page-number='1']")!
            const canvas = page.querySelector("canvas")!
            const expected = page.getBoundingClientRect().width *
              Math.max(outputScale, window.devicePixelRatio)
            return Math.abs(canvas.width - expected) <= 2
          }, MIN_PAGE_OUTPUT_SCALE),
        {
          timeout: 15_000,
          timeoutMsg: "the initial fit-width bitmap never finished rendering",
        },
      )

      const before = await browser.execute(() => {
        const page = document.querySelector("[data-page-number='1']")!
        const span = page.querySelector(".pdf-text-layer span")!
        const range = document.createRange()
        range.selectNodeContents(span)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        const canvas = page.querySelector("canvas")!

        return { bitmapWidth: canvas.width, selected: selection.toString() }
      })

      try {
        // The bridge cannot resize OS windows; the root box reaches the same
        // viewer ResizeObserver without replacing it or slowing any operation.
        await browser.execute(() => {
          const watched = window as ResizeWatch
          watched.__resizeSamples = []
          watched.__resizeDone = false
          const page = document.querySelector("[data-page-number='1']")!
          const surface = page.querySelector("[data-pdf-page-surface]")!
          const span = page.querySelector(".pdf-text-layer span")!
          const range = document.createRange()
          range.selectNodeContents(span)
          const initialWidth = document.body.clientWidth
          let frame = 0

          const resize = () => {
            const pageRect = page.getBoundingClientRect()
            const textRect = range.getBoundingClientRect()
            watched.__resizeSamples!.push({
              compositorHint: getComputedStyle(surface).willChange,
              fontSize: getComputedStyle(span).fontSize,
              pageWidth: pageRect.width,
              textLeft: (textRect.left - pageRect.left) / pageRect.width,
              textTop: (textRect.top - pageRect.top) / pageRect.height,
              textWidth: textRect.width / pageRect.width,
            })
            frame += 1
            document.body.style.width = `${initialWidth - Math.min(frame, 40) * 6}px`
            if (frame < 45) requestAnimationFrame(resize)
            else watched.__resizeDone = true
          }

          requestAnimationFrame(resize)
        })
        await browser.waitUntil(
          () => browser.execute(
            () => (window as ResizeWatch).__resizeDone === true,
          ),
          { timeout: 15_000 },
        )
        const samples = await browser.execute(
          () => (window as ResizeWatch).__resizeSamples!,
        )
        const first = samples[0]
        const last = samples.at(-1)!

        expect(last.pageWidth).toBeLessThan(first.pageWidth * 0.9)
        const widths = new Set(samples.map((sample) => sample.pageWidth))
        expect(widths.size).toBeGreaterThan(10)
        expect(
          samples.some((sample) => sample.compositorHint === "transform"),
        ).toBe(true)
        // Visual size changes each frame, while font metrics stay reusable.
        expect(new Set(samples.map((sample) => sample.fontSize)).size).toBe(1)
        for (const sample of samples) {
          expect(Math.abs(sample.textLeft - first.textLeft)).toBeLessThan(0.002)
          expect(Math.abs(sample.textTop - first.textTop)).toBeLessThan(0.002)
          expect(Math.abs(sample.textWidth - first.textWidth)).toBeLessThan(0.002)
        }
        const selected = await browser.execute(
          () => window.getSelection()!.toString(),
        )
        expect(selected).toBe(before.selected)

        await browser.waitUntil(
          async () => {
            const canvas = $("[data-page-number='1'] canvas")
            return Number(await canvas.getAttribute("width")) < before.bitmapWidth
          },
          {
            timeout: 15_000,
            timeoutMsg: "the settled page never received its new bitmap",
          },
        )
        await browser.waitUntil(
          () =>
            browser.execute(
              () =>
                document.querySelector("[data-resize-compositing]") === null,
            ),
          { timeout: 5_000, timeoutMsg: "the compositor hint never cleared" },
        )
      } finally {
        await browser.execute(() => {
          document.body.style.width = ""
          window.getSelection()?.removeAllRanges()
        })
      }
    })
  }
})
