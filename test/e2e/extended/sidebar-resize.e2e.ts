import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { activeSidebar, bandedPdf, openPdfFromDisk, refreshApp, seedSettings } from "../helpers"

const handle = `${activeSidebar} [data-slot='sidebar-resize']`

function columns() {
  return browser.execute(
    (within: string) =>
      Number(
        document
          .querySelector(`${within} [data-thumbnail-columns]`)
          ?.getAttribute("data-thumbnail-columns"),
      ),
    activeSidebar,
  )
}

describe("TFolio sidebar resizing", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("takes more columns only once a widening drag rests, never every count on the way", async () => {
    await openPdfFromDisk("widening.pdf", bandedPdf(30))
    await $(`${activeSidebar} [data-thumbnail-page='1'] canvas[data-rendered='true']`).waitForExist()

    // A drag out to the widest, a move each frame: what the column lays out
    // meanwhile, frame by frame.
    const seen = await browser.executeAsync(
      (selector: string, scope: string, done: (counts: string[]) => void) => {
        const edge = document.querySelector<HTMLElement>(selector)!
        const box = edge.getBoundingClientRect()
        const start = { x: box.left + box.width / 2, y: box.top + 200 }
        const counts: string[] = []
        let frame = 0

        edge.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            clientX: start.x,
            clientY: start.y,
            isPrimary: true,
          }),
        )

        const tick = () => {
          frame += 1
          document.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              clientX: start.x + frame * 8,
              clientY: start.y,
            }),
          )
          counts.push(
            document
              .querySelector(`${scope} [data-thumbnail-columns]`)!
              .getAttribute("data-thumbnail-columns")!,
          )

          if (frame < 50) {
            requestAnimationFrame(tick)
          } else {
            document.dispatchEvent(
              new PointerEvent("pointerup", {
                bubbles: true,
                clientX: start.x + frame * 8,
                clientY: start.y,
              }),
            )
            done(counts)
          }
        }

        requestAnimationFrame(tick)
      },
      handle,
      activeSidebar,
    )

    expect(new Set(seen)).toEqual(new Set(["1"]))
    await browser.waitUntil(async () => (await columns()) === 3, {
      timeoutMsg: "the rested sidebar never took its columns",
    })
  })

  it("takes the columns of a double-click's widening at once", async () => {
    await openPdfFromDisk("stepped.pdf", bandedPdf(30))
    await $(`${activeSidebar} [data-thumbnail-page='1'] canvas[data-rendered='true']`).waitForExist()
    expect(await columns()).toBe(1)

    // Two frames after the step, well inside a drag's wait.
    const counts = await browser.executeAsync(
      (selector: string, scope: string, done: (counts: string[]) => void) => {
        const read = () =>
          document
            .querySelector(`${scope} [data-thumbnail-columns]`)!
            .getAttribute("data-thumbnail-columns")!

        document.querySelector(selector)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
        requestAnimationFrame(() => requestAnimationFrame(() => done([read()])))
      },
      handle,
      activeSidebar,
    )

    expect(counts).toEqual(["3"])
  })
})
