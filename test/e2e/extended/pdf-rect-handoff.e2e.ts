import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  dropZoneButton,
  openPdfFromDisk,
  refreshApp,
  renderedPage,
  seedSettings,
  stripedPdf,
} from "../helpers"

describe("TFolio rectangle previews handed to the page", () => {
  beforeEach(async () => {
    // Draw with the default style, whatever a prior run persisted.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("striped.pdf", stripedPdf())
    await renderedPage()
  })

  for (const effect of ["Translucent", "Gaussian blur", "Mosaic"]) {
    it(`hands the ${effect} preview to the page without a missing or doubled frame`, async () => {
      await $("button[aria-label='Rectangle options']").click()
      await $(`button[aria-label='${effect}']`).click()
      await $("button[aria-label='Draw a rectangle']").click()

      const result = await browser.executeAsync((done: (result: {
        decodes: number
        doubled: boolean
        landed: boolean
        missing: boolean
        paintedPreview: boolean
        replaced: boolean
        waitingFrames: number
      }) => void) => {
        const page = document.querySelector("[data-page-number='1']")!
        const source = page.querySelector<HTMLCanvasElement>("canvas")!
        const clean = source.toDataURL()
        const box = page.getBoundingClientRect()
        const point = (fraction: number) => ({
          clientX: box.left + box.width * fraction,
          clientY: box.top + box.height * fraction,
        })
        const selector = "[data-slot='rect-draft-preview']"
        const frame = () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        )

        void (async () => {
          source.dispatchEvent(new PointerEvent("pointerdown", {
            bubbles: true, button: 0, isPrimary: true, ...point(0.3),
          }))
          document.dispatchEvent(new PointerEvent("pointermove", {
            bubbles: true, ...point(0.7),
          }))
          await frame()
          await frame()
          await frame()
          const original = page.querySelector(selector)
          const previewCanvas = original?.querySelector("canvas")
          const paintedPreview = !previewCanvas || previewCanvas.getContext("2d")!
            .getImageData(0, 0, 1, 1).data[3]! > 0

          // Delay only decoding, by holding back the decode worker's requests:
          // the annotation still goes through real IPC, PDFium, and history.
          // An IPC-success-only fix fails during this gap.
          const post = Worker.prototype.postMessage
          let decodes = 0
          Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<typeof post>) {
            decodes += 1
            setTimeout(() => post.apply(this, args), 500)
          } as typeof post

          let missing = false
          let doubled = false
          let replaced = false
          let waitingFrames = 0
          let landed = false
          try {
            document.dispatchEvent(new PointerEvent("pointerup", {
              bubbles: true, ...point(0.7),
            }))
            const deadline = performance.now() + 10_000
            while (performance.now() < deadline) {
              await frame()
              const preview = page.querySelector(selector)
              const changed = source.toDataURL() !== clean
              if (!changed) {
                waitingFrames += 1
                missing ||= !preview
                replaced ||= preview !== original
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
          done({ decodes, doubled, landed, missing, paintedPreview, replaced, waitingFrames })
        })()
      })

      expect(result.paintedPreview).toBe(true)
      expect(result.decodes).toBeGreaterThan(0)
      expect(result.waitingFrames).toBeGreaterThan(2)
      expect(result.missing).toBe(false)
      expect(result.replaced).toBe(false)
      expect(result.doubled).toBe(false)
      expect(result.landed).toBe(true)
      await browser.saveScreenshot(
        `artifacts/e2e/rectangle-${effect.toLowerCase().replaceAll(" ", "-")}.png`,
      )
    })
  }
})
