import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"

// A one-page PDF with a line of real text, so there is something to select and
// something for a highlight to sit over. Built inline, like the viewer suite's
// fixtures, rather than carried as a binary.
function textPdf() {
  const content = "BT\n/F1 24 Tf\n40 200 Td\n(Highlight me please) Tj\nET\n"
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
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
 * How much ink page 1 currently carries, read back off the canvas.
 *
 * Measured from the pixels rather than from the annotation the app thinks it
 * added, because those are different claims: PDFium will accept, store, and
 * report an annotation it then declines to draw. Only the canvas can say
 * whether the reader can actually see the mark.
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

describe("TFolio annotations", () => {
  beforeEach(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "single")
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await $("input[aria-label='Choose a PDF file']").waitForExist({ timeout: 30_000 })
    await selectFile("text.pdf", textPdf())
    await renderedPage()
  })

  it("highlights the selected text, and undo takes it back", async () => {
    await expect($$(".pdf-text-layer span")).not.toBeElementsArrayOfSize(0)

    const clean = await pageInk()

    await $("button[aria-label='Highlight text']").click()
    await expect($("button[aria-label='Highlight text']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    // Select a run the way a reader would: press on the text, drag out a
    // selection, let go. The press matters — letting go is only a commit when
    // the gesture began on the text, so a bare pointerup would prove nothing a
    // reader could reproduce.
    const selectedText = await browser.execute(() => {
      const span = document.querySelector(".pdf-text-layer span")

      if (!span) {
        return null
      }

      span.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))

      const range = document.createRange()
      range.selectNodeContents(span)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)

      return span.textContent
    })
    expect(selectedText).toContain("Highlight")

    await browser.execute(() => {
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
    })

    // The page is re-rastered by PDFium, so the ink arrives a beat after the
    // command does.
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    const highlighted = await pageInk()

    // Committing a mark clears the selection, so the tint left behind is the
    // drawn highlight rather than the browser's own.
    const stillSelected = await browser.execute(
      () => window.getSelection()?.toString() ?? "",
    )
    expect(stillSelected).toBe("")

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await pageInk()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the highlight back off the page",
    })

    // …and redo puts back exactly the mark that was there, not merely some ink.
    // Exact, because redo re-runs the same command into a deterministic render:
    // a redo that applied the command twice would stack two highlights and read
    // as a pass against any "more ink than clean" bar.
    await $("button[aria-label='Redo']").click()
    await browser.waitUntil(async () => (await pageInk()) === highlighted, {
      timeout: 15_000,
      timeoutMsg: "redo did not restore the highlight exactly",
    })
  })

  it("leaves undo and redo alone until there is something to take back", async () => {
    await expect($("button[aria-label='Undo']")).toBeDisabled()
    await expect($("button[aria-label='Redo']")).toBeDisabled()
  })

  // A selection outlives the drag that made it, and clicking a button does not
  // clear it. Committing on any release at all would mark that stale selection
  // when the reader pressed a toolbar control — so pressing Undo would *add* a
  // highlight, and then have nothing to undo.
  it("does not mark a stale selection when a toolbar button is clicked", async () => {
    const clean = await pageInk()

    // Select some text with the tool off, as a reader would to read or copy it.
    await browser.execute(() => {
      const span = document.querySelector(".pdf-text-layer span")!
      const range = document.createRange()
      range.selectNodeContents(span)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })

    // Turn the tool on, then press a toolbar button while the selection stands.
    await $("button[aria-label='Highlight text']").click()
    await $("button[aria-label='Rotate clockwise']").click()
    await browser.pause(2500)

    await expect($("button[aria-label='Undo']")).toBeDisabled()
    expect(await pageInk()).toBe(clean)
  })
})
