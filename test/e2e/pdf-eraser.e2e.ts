import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  dropZoneButton,
  openPdfFromDisk,
  pagePixelFingerprint,
  renderedPage,
  seedSettings,
  stripedPdf,
} from "./helpers"

/** Drags a rectangle across a corner of page 1, in fractions of its box. */
async function dragRect(from: [number, number], to: [number, number]) {
  await browser.execute(
    (corners: number[]) => {
      const page = document.querySelector("[data-page-number='1']")!
      const canvas = page.querySelector("canvas")!
      const box = page.getBoundingClientRect()
      const at = (x: number, y: number) => ({
        clientX: box.left + box.width * x,
        clientY: box.top + box.height * y,
      })
      const start = at(corners[0]!, corners[1]!)
      const end = at(corners[2]!, corners[3]!)

      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          isPrimary: true,
          ...start,
        }),
      )
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, ...end }))
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, ...end }))
    },
    [...from, ...to],
  )
}

/** Presses and releases on one point of page 1 — what the eraser aims with. */
async function clickPage(x: number, y: number) {
  await browser.execute(
    (spot: number[]) => {
      const page = document.querySelector("[data-page-number='1']")!
      const canvas = page.querySelector("canvas")!
      const box = page.getBoundingClientRect()
      const point = {
        clientX: box.left + box.width * spot[0]!,
        clientY: box.top + box.height * spot[1]!,
      }

      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          isPrimary: true,
          ...point,
        }),
      )
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, ...point }))
    },
    [x, y],
  )
}

async function settledAt(fingerprint: number, message: string) {
  await browser.waitUntil(async () => (await pagePixelFingerprint()) === fingerprint, {
    timeout: 15_000,
    timeoutMsg: message,
  })
}

async function changedFrom(fingerprint: number, message: string) {
  await browser.waitUntil(async () => (await pagePixelFingerprint()) !== fingerprint, {
    timeout: 15_000,
    timeoutMsg: message,
  })
}

describe("TFolio eraser", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("striped.pdf", stripedPdf())
    await renderedPage()
  })

  it("rubs out the mark under the pointer and puts it back on undo", async () => {
    const clean = await pagePixelFingerprint()

    await $("button[aria-label='Draw a rectangle']").click()
    await dragRect([0.32, 0.32], [0.48, 0.48])
    await changedFrom(clean, "the first rectangle never reached the page")

    const first = await pagePixelFingerprint()

    await dragRect([0.52, 0.52], [0.68, 0.68])
    await changedFrom(first, "the second rectangle never reached the page")

    const both = await pagePixelFingerprint()

    await $("button[aria-label='Erase a mark']").click()
    await expect($("button[aria-label='Erase a mark']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    // The rectangle tool goes away when the eraser comes out: one tool at a
    // time, so this click cannot also draw.
    await expect($("button[aria-label='Draw a rectangle']")).toHaveAttribute(
      "aria-pressed",
      "false",
    )

    // A point on bare page is a point on nothing: the document is left alone.
    await clickPage(0.1, 0.1)
    await settledAt(both, "a click off every mark changed the page")

    // The mark it takes is the older one, from the middle of the page's own
    // stack — which is exactly what undo could not have reached.
    await clickPage(0.4, 0.4)
    await browser.waitUntil(
      async () => {
        const now = await pagePixelFingerprint()

        return now !== both && now !== clean
      },
      { timeout: 15_000, timeoutMsg: "the eraser never took the rectangle off" },
    )

    const erased = await pagePixelFingerprint()

    // Exact, not merely "different": the second rectangle has to come back
    // where it was, and only the erased one has to reappear.
    await $("button[aria-label^='Undo']").click()
    await settledAt(both, "undo did not put the erased rectangle back")

    await $("button[aria-label^='Redo']").click()
    await settledAt(erased, "redo did not take the rectangle off again")

    // And the marks either side of it still answer to their own undo.
    await $("button[aria-label^='Undo']").click()
    await settledAt(both, "undo did not put the erased rectangle back a second time")
    await $("button[aria-label^='Undo']").click()
    await changedFrom(both, "undo did not take the second rectangle back")
    await $("button[aria-label^='Undo']").click()
    await settledAt(clean, "undo did not take the first rectangle back")
  })

  it("is offered only where there is a page to rub a mark off", async () => {
    await expect($("button[aria-label='Erase a mark']")).toExist()

    await $("button[aria-label='Thumbnails']").click()
    await expect($("button[aria-label='Erase a mark']")).not.toExist()
  })
})
