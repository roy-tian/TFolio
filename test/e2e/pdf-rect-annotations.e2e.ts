import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { rectStyleStorageKey } from "../../src/lib/annotationStyles"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import {
  blankPdf,
  dropZoneButton,
  openPdfFromDisk,
  pageInk,
  renderedPage,
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

describe("TFolio rectangle annotations", () => {
  beforeEach(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "single")
        // Draw with the default style, whatever a prior run persisted.
        window.localStorage.removeItem(keys.rectStyle)
      },
      {
        language: languageStorageKey,
        rectStyle: rectStyleStorageKey,
        viewMode: viewModeStorageKey,
      },
    )
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("blank.pdf", blankPdf())
    await renderedPage()
  })

  it("draws a rectangle, and undo and redo restore it exactly", async () => {
    const clean = await pageInk()

    await $("button[aria-label='Draw a rectangle']").click()
    await expect($("button[aria-label='Draw a rectangle']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    await dragRectOnPage()

    // The page is re-rastered by PDFium, so the mark arrives a beat after the
    // drag ends.
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the rectangle never reached the page",
    })

    const drawn = await pageInk()

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await pageInk()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the rectangle back off the page",
    })

    // Exact, not merely "more ink than clean": a redo that applied the command
    // twice would stack two rectangles and still clear that lower bar.
    await $("button[aria-label='Redo']").click()
    await browser.waitUntil(async () => (await pageInk()) === drawn, {
      timeout: 15_000,
      timeoutMsg: "redo did not restore the rectangle exactly",
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

    await expect($("button[aria-label='Undo']")).toBeDisabled()
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

      await expect($("button[aria-label='Undo']")).toBeDisabled()
      expect(await pageInk()).toBe(clean)
    })
  }
})
