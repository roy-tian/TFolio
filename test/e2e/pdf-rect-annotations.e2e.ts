import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { rectStyleStorageKey } from "../../src/lib/annotationStyles"
import { viewModeStorageKey } from "../../src/lib/viewMode"

// A blank one-page PDF: a rectangle is drawn over the page itself, so unlike the
// highlight suite there is no need for text underneath. Built inline, like the
// other suites' fixtures, rather than carried as a binary.
function blankPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ]
  const chunks = ["%PDF-1.4\n"]
  const offsets: number[] = []
  let byteLength = Buffer.byteLength(chunks[0], "ascii")

  for (const object of objects) {
    offsets.push(byteLength)
    chunks.push(object)
    byteLength += Buffer.byteLength(object, "ascii")
  }

  const xrefOffset = byteLength
  chunks.push(`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n")

  for (const offset of offsets) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }

  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  )

  return Buffer.from(chunks.join(""), "ascii")
}

async function selectFile(name: string, contents: Uint8Array) {
  await browser.execute(
    ({ bytes, fileName }) => {
      const input = document.querySelector<HTMLInputElement>("input[type='file']")

      if (!input) {
        throw new Error("PDF file input was not found")
      }

      const file = new File([new Uint8Array(bytes)], fileName, {
        type: "application/pdf",
      })

      Object.defineProperty(input, "files", { configurable: true, value: [file] })
      input.dispatchEvent(new Event("change", { bubbles: true }))
    },
    { bytes: Array.from(contents), fileName: name },
  )
}

/**
 * How much ink page 1 currently carries, read back off the canvas — the pixels
 * rather than the annotation the app thinks it added, because PDFium will accept
 * and store a mark it then declines to draw. Only the canvas can say whether the
 * reader can actually see it.
 */
function pageInk() {
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
    let ink = 0

    for (let index = 0; index < data.length; index += 4) {
      ink += 765 - data[index]! - data[index + 1]! - data[index + 2]!
    }

    return ink
  })
}

async function renderedPage() {
  const page = await $("[data-page-number='1']")
  await page.waitForDisplayed({ timeout: 30_000 })

  const canvas = await page.$("canvas")
  await browser.waitUntil(
    async () => Number(await canvas.getAttribute("width")) > 200,
    { timeout: 30_000, timeoutMsg: "page 1 never finished rendering" },
  )
  await browser.pause(1500)
}

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
    await $("input[aria-label='Choose a PDF file']").waitForExist({ timeout: 30_000 })
    await selectFile("blank.pdf", blankPdf())
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
