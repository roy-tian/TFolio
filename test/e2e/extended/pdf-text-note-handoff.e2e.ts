import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  blankPdf,
  clickOnPage,
  dropZoneButton,
  openPdfFromDisk,
  refreshApp,
  renderedPage,
  seedSettings,
} from "../helpers"

describe("TFolio text notes handed to the page", () => {
  // The note must stay on screen from confirm until the page repaints carrying
  // it — PDFium, IPC and a decode sit between, and closing early blanked the text.
  for (const note of [
    { label: "Latin", text: "Note gy" },
    { label: "Chinese", text: "你好" },
    { label: "mixed multiline", text: "Hello 你好\n第二行" },
  ]) {
    it(`hands the ${note.label} note to the page without a blank or doubled frame`, async () => {
      // Large, so a wrong ascent is points off rather than a fraction of one.
      await seedSettings({
        annotate: { textNote: { color: "#000000", fontSize: 48, opacity: 1 } },
        ui: { language: "en", viewMode: "single" },
      })
      await refreshApp()
      await dropZoneButton().waitForExist({ timeout: 30_000 })
      await openPdfFromDisk("blank.pdf", blankPdf())
      await renderedPage()

      await $("button[aria-label='Add a note']").click()
      await clickOnPage()

      const editor = await $("textarea[aria-label='Note text']")
      await editor.waitForDisplayed({ timeout: 15_000 })
      await editor.setValue(note.text)

      const result = await browser.executeAsync((done: (result: {
        blankFrames: number
        canvasWidth: number
        doubled: boolean
        landed: boolean
        previewInkTop: number
        renderedInkTop: number
        waitingFrames: number
      }) => void) => {
        const page = document.querySelector("[data-page-number='1']")!
        const source = page.querySelector<HTMLCanvasElement>("canvas")!
        const clean = source.toDataURL()
        const selector = "[data-slot='text-note-preview']"
        const frame = () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        )
        // Where the note's ink starts, in the page's own points: the canvas is
        // rendered at some multiple of the 300x400 page.
        const inkTop = () => {
          // A `bitmaprenderer` canvas has no 2d context to read: copy it into one.
          const copy = document.createElement("canvas")
          copy.width = source.width
          copy.height = source.height
          const context = copy.getContext("2d")!
          context.drawImage(source, 0, 0)
          const { data } = context.getImageData(0, 0, copy.width, copy.height)

          for (let y = 0; y < source.height; y += 1) {
            for (let x = 0; x < source.width; x += 1) {
              const at = (y * source.width + x) * 4

              if (765 - data[at]! - data[at + 1]! - data[at + 2]! > 160) {
                return y / (source.width / 300)
              }
            }
          }

          return Number.NaN
        }

        void (async () => {
          // Only decoding is delayed, by holding back the decode worker's
          // requests — IPC, PDFium and history stay real; a fix that merely
          // kept the editor open would double the text once landed.
          const post = Worker.prototype.postMessage
          Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<typeof post>) {
            setTimeout(() => post.apply(this, args), 400)
          } as typeof post

          let blankFrames = 0
          let waitingFrames = 0
          let doubled = false
          let landed = false
          let previewInkTop = Number.NaN
          try {
            document.querySelector<HTMLButtonElement>(
              "button[aria-label='Add this note']",
            )!.click()

            const deadline = performance.now() + 25_000
            while (performance.now() < deadline) {
              await frame()
              const preview = page.querySelector(selector)
              const changed = source.toDataURL() !== clean

              if (!changed) {
                waitingFrames += 1
                if (preview) {
                  // The preview's baseline less the face's own ink ascent — an
                  // element box gives only the ascent that placed the baseline.
                  const line = preview.querySelector("text")!
                  const size = Number(line.getAttribute("font-size"))
                  const context = document.createElement("canvas").getContext("2d")!
                  context.font = `100px ${line.getAttribute("font-family")}`
                  previewInkTop =
                    Number(line.getAttribute("y")) -
                    (context.measureText(line.textContent!).actualBoundingBoxAscent /
                      100) *
                      size
                } else if (!document.querySelector("textarea[aria-label='Note text']")) {
                  blankFrames += 1
                }
              } else {
                doubled ||= Boolean(preview)
                if (!preview) {
                  landed = true
                  break
                }
              }
            }
          } finally {
            Worker.prototype.postMessage = post
          }

          // Let the render settle before the ink is measured.
          await new Promise((resolve) => setTimeout(resolve, 1000))
          done({
            blankFrames,
            canvasWidth: source.width,
            doubled,
            landed,
            previewInkTop,
            renderedInkTop: inkTop(),
            waitingFrames,
          })
        })()
      })

      expect(result.waitingFrames).toBeGreaterThan(2)
      expect(result.blankFrames).toBe(0)
      expect(result.doubled).toBe(false)
      expect(result.landed).toBe(true)
      // Four points clears the cap-height difference between PDFium's Helvetica
      // and the browser's stand-in (~1.5); the wrong face's error would be ten.
      expect(Math.abs(result.previewInkTop - result.renderedInkTop)).toBeLessThan(4)
      await browser.saveScreenshot(
        `artifacts/e2e/text-note-${note.label.toLowerCase()}.png`,
      )
    })
  }
})
