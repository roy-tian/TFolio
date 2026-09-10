import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  dropZoneButton,
  openPdfFromDisk,
  pageInk,
  pagePixelFingerprint,
  refreshApp,
  renderedPage,
  seedSettings,
  stripedPdf,
} from "./helpers"

// Drags a rectangle across the middle of page 1 the way a reader would: press on
// the page, move to the far corner, release. The press has to land on the page —
// letting go is only a commit when the gesture began there — so this proves what
// a reader can actually reproduce, not a bare call into the commit path.
async function dragRectOnPage() {
  await browser.execute(() => {
    const page = document.querySelector("[data-page-number='1']")!
    const canvas = page.querySelector("canvas")!
    const box = page.getBoundingClientRect()
    const from = { x: box.left + box.width * 0.3, y: box.top + box.height * 0.3 }
    const to = { x: box.left + box.width * 0.7, y: box.top + box.height * 0.7 }

    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: from.x,
        clientY: from.y,
        isPrimary: true,
      }),
    )
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: to.x,
        clientY: to.y,
      }),
    )
    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: to.x, clientY: to.y }),
    )
  })
}

/**
 * The share of page 1 the default red wash has tinted. The fixture is black bars
 * on white, so a red-dominant pixel can only have come from the mark.
 */
async function washedShare() {
  return browser.execute(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "[data-page-number='1'] canvas",
    )!
    const { data } = canvas.getContext("2d")!.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    )
    let washed = 0

    for (let index = 0; index < data.length; index += 4) {
      const red = data[index]!

      if (red - data[index + 1]! > 60 && red - data[index + 2]! > 60) {
        washed += 1
      }
    }

    return washed / (data.length / 4)
  })
}

describe("TFolio rectangle annotations", () => {
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

          // Delay only decoding: the annotation still goes through real IPC,
          // PDFium, and history. An IPC-success-only fix fails during this gap.
          const decode = window.createImageBitmap.bind(window)
          let decodes = 0
          window.createImageBitmap = (async (...args: Parameters<typeof decode>) => {
            const bitmap = await decode(...args)
            decodes += 1
            await new Promise((resolve) => setTimeout(resolve, 500))
            return bitmap
          }) as typeof window.createImageBitmap

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
            window.createImageBitmap = decode
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

  // The tool's own button says what a drag would leave on the page, so the three
  // effects have to be three icons rather than one box.
  it("draws the armed effect on the rectangle tool", async () => {
    const toolIcon = () => $("button[aria-label='Draw a rectangle'] svg")

    for (const [effect, icon] of [
      ["Gaussian blur", "lucide-rect-blur"],
      ["Mosaic", "lucide-rect-mosaic"],
      ["Translucent", "lucide-square"],
    ] as const) {
      await $("button[aria-label='Rectangle options']").click()
      await $(`button[aria-label='${effect}']`).click()
      await browser.keys("Escape")
      await expect(toolIcon()).toHaveElementClass(icon, { containing: true })
    }
  })

  it("boots the rectangle tool on the effect the settings hold", async () => {
    await seedSettings({
      annotate: {
        rect: { color: "#ef4444", effect: "mosaic", opacity: 0.5, strength: 8 },
      },
      ui: { language: "en", viewMode: "single" },
    })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("striped.pdf", stripedPdf())
    await renderedPage()

    await expect($("button[aria-label='Draw a rectangle'] svg")).toHaveElementClass(
      "lucide-rect-mosaic",
      { containing: true },
    )
  })

  it("keeps consecutive released rectangles when another tool is selected", async () => {
    const clean = await pagePixelFingerprint()
    await $("button[aria-label='Draw a rectangle']").click()

    const result = await browser.executeAsync((done: (result: {
      count: number
      retained: boolean
    }) => void) => {
      const source = document.querySelector<HTMLCanvasElement>(
        "[data-page-number='1'] canvas",
      )!
      const page = source.closest("[data-page-number]")!
      const box = page.getBoundingClientRect()
      const selector = "[data-slot='rect-draft-preview']"
      const frame = () => new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
      const decode = window.createImageBitmap.bind(window)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      window.createImageBitmap = (async (...args: Parameters<typeof decode>) => {
        const bitmap = await decode(...args)
        await gate
        return bitmap
      }) as typeof window.createImageBitmap

      const drag = async (from: number, to: number) => {
        source.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true, button: 0, isPrimary: true,
          clientX: box.left + box.width * from,
          clientY: box.top + box.height * from,
        }))
        document.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: box.left + box.width * to,
          clientY: box.top + box.height * to,
        }))
        await frame()
        document.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true,
          clientX: box.left + box.width * to,
          clientY: box.top + box.height * to,
        }))
        await frame()
      }

      void (async () => {
        try {
          await drag(0.2, 0.4)
          const first = page.querySelector(selector)
          await drag(0.6, 0.8)
          document.querySelector<HTMLButtonElement>("button[aria-label='Erase a mark']")!.click()
          await frame()
          await frame()
          done({
            count: page.querySelectorAll(selector).length,
            retained: Boolean(first?.isConnected),
          })
        } finally {
          window.createImageBitmap = decode
          release()
        }
      })()
    })

    expect(result.count).toBe(2)
    expect(result.retained).toBe(true)
    await browser.waitUntil(async () =>
      (await pagePixelFingerprint()) !== clean &&
      !(await $("[data-slot='rect-draft-preview']").isExisting()),
    )
    const both = await pagePixelFingerprint()
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) !== both)
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean)
  })

  it("draws a rectangle, and undo and redo restore it exactly", async () => {
    const clean = await pagePixelFingerprint()

    await $("button[aria-label='Draw a rectangle']").click()
    await expect($("button[aria-label='Draw a rectangle']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    await dragRectOnPage()

    // The page is re-rastered by PDFium, so the mark arrives a beat after the
    // drag ends.
    await browser.waitUntil(async () => (await pagePixelFingerprint()) !== clean, {
      timeout: 15_000,
      timeoutMsg: "the rectangle never reached the page",
    })
    // Drawn, not merely stored: PDFium will accept and keep a mark it then
    // declines to paint. The drag covers the middle two fifths of each side, so
    // the default half-opaque red block has to tint about a sixth of the page.
    expect(await washedShare()).toBeGreaterThan(0.1)

    const drawn = await pagePixelFingerprint()

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the rectangle back off the page",
    })

    // Exact, not merely "different from clean": a redo that applied the command
    // twice would stack two rectangles and still clear that lower bar.
    await $("button[aria-label^='Redo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === drawn, {
      timeout: 15_000,
      timeoutMsg: "redo did not restore the rectangle exactly",
    })
  })

  it("gives each effect its own settings, and applies a mosaic", async () => {
    const clean = await pagePixelFingerprint()

    await $("button[aria-label='Rectangle options']").click()
    const amount = await $("[data-slot='rect-amount']")
    const colors = await $("[data-slot='rect-colors']")
    const white = await $("[data-slot='rect-colors'] [aria-label='#ffffff']")
    const disclosure = await $("[data-slot='rect-effect-disclosure']")
    const about = await $("button[aria-label='About this effect']")

    // Translucent: the colour is the mark, so the swatches are on the panel and
    // the one slider is its opacity. The swatches are the whole offer — no well
    // for a colour off the row.
    await expect(amount).toHaveText(/Opacity/)
    await expect(white).toExist()
    await expect($("[data-slot='rect-colors'] input[type='color']")).not.toExist()
    await expect(about).not.toExist()

    // A mosaic is built from the pixels under the box, so the colour has
    // nothing to tint and leaves the panel altogether.
    await $("button[aria-label='Mosaic']").click()
    await expect(amount).toHaveText(/Mosaic size/)
    await expect(colors).not.toExist()

    await expect(disclosure).not.toExist()
    await about.click()
    await expect(disclosure).toHaveText(
      "Not redaction: the underlying text remains searchable and copyable. Use this visual effect for printing only.",
    )
    await about.click()
    await expect(disclosure).not.toExist()

    await $("button[aria-label='Gaussian blur']").click()
    await expect(amount).toHaveText(/Blur strength/)
    await expect(colors).not.toExist()

    await $("button[aria-label='Translucent']").click()
    await expect(amount).toHaveText(/Opacity/)
    await expect(white).toExist()
    await expect(about).not.toExist()

    await $("button[aria-label='Mosaic']").click()
    await $("button[aria-label='Draw a rectangle']").click()
    await dragRectOnPage()

    await browser.waitUntil(async () => (await pagePixelFingerprint()) !== clean, {
      timeout: 15_000,
      timeoutMsg: "the mosaic never reached the page",
    })

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pagePixelFingerprint()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the mosaic back off the page",
    })
  })

  it("keeps a blur preview opaque through every crop edge", async () => {
    await $("button[aria-label='Rectangle options']").click()
    await $("button[aria-label='Gaussian blur']").click()
    await $("button[aria-label='Draw a rectangle']").click()

    await browser.execute(() => {
      const page = document.querySelector("[data-page-number='1']")!
      const canvas = page.querySelector("canvas")!
      const box = page.getBoundingClientRect()
      const from = { x: box.left + box.width * 0.25, y: box.top + box.height * 0.25 }
      const to = { x: box.left + box.width * 0.75, y: box.top + box.height * 0.75 }

      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: from.x,
          clientY: from.y,
          isPrimary: true,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: to.x,
          clientY: to.y,
        }),
      )
    })

    const preview = await $("[data-slot='rect-effect-preview']")
    await preview.waitForExist()
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            "[data-slot='rect-effect-preview']",
          )!
          const context = canvas.getContext("2d")

          return Boolean(
            context &&
              canvas.width > 1 &&
              context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1,
              ).data[3]! > 0,
          )
        }),
      { timeoutMsg: "the blur preview never painted" },
    )

    const minimumEdgeAlpha = await browser.execute(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        "[data-slot='rect-effect-preview']",
      )!
      const context = canvas.getContext("2d")!
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let minimum = 255

      const include = (x: number, y: number) => {
        minimum = Math.min(minimum, data[(y * canvas.width + x) * 4 + 3]!)
      }

      for (let x = 0; x < canvas.width; x += 1) {
        include(x, 0)
        include(x, canvas.height - 1)
      }
      for (let y = 0; y < canvas.height; y += 1) {
        include(0, y)
        include(canvas.width - 1, y)
      }

      return minimum
    })

    expect(minimumEdgeAlpha).toBeGreaterThanOrEqual(250)

    await browser.execute(() => {
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
    })
  })

  it("refreshes a live effect after the source bitmap repaints", async () => {
    await $("button[aria-label='Rectangle options']").click()
    await $("button[aria-label='Mosaic']").click()
    await $("button[aria-label='Draw a rectangle']").click()

    await browser.execute(() => {
      const page = document.querySelector("[data-page-number='1']")!
      const source = page.querySelector<HTMLCanvasElement>("canvas")!
      const box = page.getBoundingClientRect()
      const from = { x: box.left + box.width * 0.25, y: box.top + box.height * 0.25 }
      const to = { x: box.left + box.width * 0.75, y: box.top + box.height * 0.75 }

      source.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: from.x,
          clientY: from.y,
          isPrimary: true,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: to.x,
          clientY: to.y,
        }),
      )
    })

    const preview = await $("[data-slot='rect-effect-preview']")
    await preview.waitForExist()
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            "[data-slot='rect-effect-preview']",
          )!
          return canvas.width > 1 && canvas.height > 1
        }),
      { timeoutMsg: "the mosaic preview never sized itself" },
    )

    await browser.execute(() => {
      const page = document.querySelector("[data-page-number='1']")!
      const source = page.querySelector<HTMLCanvasElement>("canvas")!
      const sourceContext = source.getContext("2d")!
      const box = page.getBoundingClientRect()

      sourceContext.fillStyle = "#ff00ff"
      sourceContext.fillRect(0, 0, source.width, source.height)
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: box.left + box.width * 0.74,
          clientY: box.top + box.height * 0.74,
        }),
      )
    })

    const previewCenter = () =>
      browser.execute(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          "[data-slot='rect-effect-preview']",
        )!
        return Array.from(
          canvas
            .getContext("2d")!
            .getImageData(
              Math.floor(canvas.width / 2),
              Math.floor(canvas.height / 2),
              1,
              1,
            ).data,
        )
      })

    await browser.waitUntil(
      async () => {
        const [red, green, blue] = await previewCenter()
        return red! > 240 && green! < 15 && blue! > 240
      },
      { timeoutMsg: "the preview never sampled the temporary source pixels" },
    )

    await browser.execute(() => {
      const page = document.querySelector("[data-page-number='1']")!
      const box = page.getBoundingClientRect()

      // Every workspace panel carries a `<main>`, the home tab's included, and
      // all but the showing one are `hidden`. The wheel has to reach this
      // document's viewer, which is the active panel's.
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!

      viewer.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          ctrlKey: true,
          deltaY: -100,
        }),
      )
    })

    await browser.waitUntil(
      async () => {
        const [red, green, blue] = await previewCenter()
        return red! < 230 || green! > 30 || blue! < 230
      },
      {
        timeout: 30_000,
        timeoutMsg: "the repainted page never refreshed the live preview",
      },
    )

    await browser.execute(() => {
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
    })
  })

  // A gesture that began off any page is not a draw. Pressing a toolbar button
  // and then moving over the page must not leave a rectangle behind — otherwise
  // turning the tool on and clicking around would litter the document.
  it("does not draw when the gesture began off the page", async () => {
    const clean = await pageInk()

    await $("button[aria-label='Draw a rectangle']").click()

    await browser.execute(() => {
      const button = document.querySelector("button[aria-label='Draw a rectangle']")!
      const page = document.querySelector("[data-page-number='1']")!
      const box = page.getBoundingClientRect()

      button.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: box.left + box.width * 0.5,
          clientY: box.top + box.height * 0.5,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: box.left + box.width * 0.7,
          clientY: box.top + box.height * 0.7,
        }),
      )
    })

    await browser.pause(2500)

    await expect($("button[aria-label^='Undo']")).toBeDisabled()
    expect(await pageInk()).toBe(clean)
  })

  // Only the primary button of the primary pointer draws. A secondary button
  // (a right-click) and a secondary pointer (a second finger) are each refused,
  // so both guards are covered — removing either would turn one of these red.
  for (const secondary of [
    { button: 2, isPrimary: true, name: "a non-primary button" },
    { button: 0, isPrimary: false, name: "a non-primary pointer" },
  ]) {
    it(`does not draw on ${secondary.name}`, async () => {
      const clean = await pageInk()

      await $("button[aria-label='Draw a rectangle']").click()

      await browser.execute((event) => {
        const page = document.querySelector("[data-page-number='1']")!
        const canvas = page.querySelector("canvas")!
        const box = page.getBoundingClientRect()
        const from = { x: box.left + box.width * 0.3, y: box.top + box.height * 0.3 }
        const to = { x: box.left + box.width * 0.7, y: box.top + box.height * 0.7 }

        canvas.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: event.button,
            clientX: from.x,
            clientY: from.y,
            isPrimary: event.isPrimary,
          }),
        )
        document.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: to.x, clientY: to.y }),
        )
        document.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, clientX: to.x, clientY: to.y }),
        )
      }, secondary)

      await browser.pause(2500)

      await expect($("button[aria-label^='Undo']")).toBeDisabled()
      expect(await pageInk()).toBe(clean)
    })
  }
})
