import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { activeSidebar, bandedPdf, openPdfFromDisk, refreshApp, seedSettings } from "../helpers"

const handle = `${activeSidebar} [data-slot='sidebar-resize']`
// PageThumbnails' COLUMNS_SETTLE_MS: how long a widening drag rests before
// the column takes more columns.
const SETTLE_MS = 150

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
    // Made before the document's column makes its own: observers hear of a
    // resize in the order they were made, so this one times each resize just
    // before the column starts its wait.
    await browser.execute(() => {
      const probe = window as Window & { __resized?: number; __resizes?: ResizeObserver }

      probe.__resizes = new ResizeObserver(() => {
        probe.__resized = performance.now()
      })
    })
    await openPdfFromDisk("widening.pdf", bandedPdf(30))
    await $(`${activeSidebar} [data-thumbnail-page='1'] canvas[data-rendered='true']`).waitForExist()

    // A drag out to the widest, a move each frame. A frame slower than the
    // wait, as on a loaded machine, is a rest of its own: each count the
    // column takes while the drag is held, and how long after the last
    // resize it took it.
    const changes = await browser.executeAsync(
      (
        selector: string,
        scope: string,
        done: (changes: { columns: string; afterResize: number }[]) => void,
      ) => {
        const probe = window as Window & { __resized?: number; __resizes?: ResizeObserver }
        const edge = document.querySelector<HTMLElement>(selector)!
        const column = document.querySelector<HTMLElement>(`${scope} [data-thumbnail-columns]`)!
        const box = edge.getBoundingClientRect()
        const start = { x: box.left + box.width / 2, y: box.top + 200 }
        const changes: { columns: string; afterResize: number }[] = []
        let held = true
        let shown = column.getAttribute("data-thumbnail-columns")
        let frame = 0

        probe.__resizes!.observe(column.closest("[role='navigation']")!)
        new MutationObserver(() => {
          const columns = column.getAttribute("data-thumbnail-columns")!

          if (held && columns !== shown) {
            changes.push({ afterResize: performance.now() - probe.__resized!, columns })
          }
          shown = columns
        }).observe(column, { attributeFilter: ["data-thumbnail-columns"] })

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

          if (frame < 50) {
            requestAnimationFrame(tick)
          } else {
            held = false
            document.dispatchEvent(
              new PointerEvent("pointerup", {
                bubbles: true,
                clientX: start.x + frame * 8,
                clientY: start.y,
              }),
            )
            done(changes)
          }
        }

        requestAnimationFrame(tick)
      },
      handle,
      activeSidebar,
    )

    expect(changes.filter(({ afterResize }) => afterResize < SETTLE_MS)).toEqual([])
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
