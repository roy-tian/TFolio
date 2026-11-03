import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "./helpers"
import { calibratePointer, pointer } from "./nativePointer"

const session = "[data-document-session][data-active='true']"
const bar = `${session} [data-slot='status-bar']`

function labelsIn(scope: string) {
  return browser.execute(
    (css: string) =>
      Array.from(
        document.querySelectorAll(`${css} button[aria-label], ${css} input[aria-label]`),
        (control) => control.getAttribute("aria-label"),
      ),
    scope,
  )
}

describe("TFolio viewer controls", () => {
  let offset: { x: number; y: number }
  const moveTo = (x: number, y: number) => pointer({ x: x + offset.x, y: y + offset.y })

  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("viewer-controls.pdf", minimalPdf(3, "0 0 595 842"))
    await $(`${session} [data-page-number='1'] canvas[data-rendered='true']`).waitForExist()
    offset = await calibratePointer()
  })

  it("puts where the reader is and how the pages are looked at in a status bar under the viewer", async () => {
    const titleBar = await labelsIn(`${session} [data-slot='toolbar']`)

    // The order reads left to right: the page, then layout, zoom, the named
    // sizings, the turn.
    const viewing = [
      "Page number",
      "Single page",
      "Book",
      "Zoom out",
      "Zoom",
      "Zoom in",
      "Actual size",
      "Fit width",
      "Fit page",
      "Rotate the view clockwise",
    ]
    expect(await labelsIn(bar)).toEqual(viewing)
    for (const label of viewing) {
      expect(titleBar).not.toContain(label)
    }

    // Right of the sidebar to the window's edges; the viewer ends where it
    // starts, so it covers no page.
    const layout = await browser.execute((css: string, scope: string) => {
      const box = document.querySelector(css)!.getBoundingClientRect()
      return {
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        sidebarRight: document
          .querySelector(`${scope} [data-slot='app-sidebar']`)!
          .getBoundingClientRect().right,
        top: box.top,
        viewerBottom: document
          .querySelector(`${scope} [data-pdf-scroll-root]`)!
          .getBoundingClientRect().bottom,
        viewport: { height: innerHeight, width: innerWidth },
      }
    }, bar, session)
    expect(Math.round(layout.bottom)).toBe(layout.viewport.height)
    expect(Math.round(layout.right)).toBe(layout.viewport.width)
    expect(Math.round(layout.left)).toBe(Math.round(layout.sidebarRight))
    expect(Math.round(layout.viewerBottom)).toBe(Math.round(layout.top))
  })

  it("zooms as the slider is dragged, laying the pages out once let go", async () => {
    const zoomGroup = $(`${session} [data-slot='zoom-controls']`)
    const readout = $(`${bar} [data-slot='zoom-controls-readout']`)
    await $(`${bar} button[aria-label='Actual size']`).click()
    await expect(zoomGroup).toHaveAttribute("aria-label", "Zoom 100%")
    await expect(readout).toHaveText("100%")

    const pageWidth = () =>
      browser.execute((css: string) =>
        document.querySelector(`${css} [data-page-number='1']`)!.getBoundingClientRect().width,
      session)
    const widthAtActualSize = await pageWidth()
    const thumb = await browser.execute((css: string) => {
      const rect = document.querySelector(`${css} [data-slot='slider-thumb']`)!.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, bar)

    moveTo(thumb.x, thumb.y)
    pointer({ down: true })
    try {
      moveTo(thumb.x + 15, thumb.y)
      moveTo(thumb.x + 25, thumb.y)
      await browser.waitUntil(async () => (await readout.getText()) !== "100%", {
        timeoutMsg: "the readout never followed the drag",
      })
      // Held still well past the wheel's 150ms settle, the drag stays a preview.
      await browser.pause(500)
      expect(await zoomGroup.getAttribute("aria-label")).toBe("Zoom 100%")
    } finally {
      pointer({ down: false })
    }

    await browser.waitUntil(
      async () => (await zoomGroup.getAttribute("aria-label")) !== "Zoom 100%",
      { timeoutMsg: "letting go of the slider never zoomed" },
    )
    const level = Number((await zoomGroup.getAttribute("aria-label"))!.match(/\d+/)![0])
    expect(level).toBeGreaterThan(100)
    await expect(readout).toHaveText(`${level}%`)
    await browser.waitUntil(async () => (await pageWidth()) > widthAtActualSize, {
      timeoutMsg: "the pages were never laid out at the dragged zoom",
    })
  })
})
