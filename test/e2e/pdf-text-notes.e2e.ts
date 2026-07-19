import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { textNoteStyleStorageKey } from "../../src/lib/annotationStyles"
import { viewModeStorageKey } from "../../src/lib/viewMode"

// A blank one-page PDF, as the rectangle suite uses: a note is typed onto the
// page itself, so nothing needs to be underneath it.
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

/** The ink page 1 carries, off the canvas — see the rectangle suite for why. */
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

/** Places a note by clicking the page, the way a reader opens one. */
async function clickOnPage(atX = 0.3, atY = 0.3) {
  await browser.execute(
    (at) => {
      const page = document.querySelector("[data-page-number='1']")!
      const canvas = page.querySelector("canvas")!
      const box = page.getBoundingClientRect()

      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: box.left + box.width * at.x,
          clientY: box.top + box.height * at.y,
          isPrimary: true,
        }),
      )
    },
    { x: atX, y: atY },
  )
}

/**
 * Presses a control the way a reader does — with a real `pointerdown` first.
 *
 * WebDriver's own click fires neither `pointerdown` nor `mousedown` here, so a
 * test that only clicks never reaches the document-level listener that decides
 * what happens to an open note. Any test asserting the note survives (or does
 * not survive) a press has to send the press itself.
 */
async function pressControl(selector: string) {
  await browser.execute((query) => {
    const control = document.querySelector(query)!
    control.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true }),
    )
  }, selector)
  await $(selector).click()
}

describe("TFolio text notes", () => {
  beforeEach(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "single")
        window.localStorage.removeItem(keys.textNoteStyle)
      },
      {
        language: languageStorageKey,
        textNoteStyle: textNoteStyleStorageKey,
        viewMode: viewModeStorageKey,
      },
    )
    await browser.refresh()
    await $("input[aria-label='Choose a PDF file']").waitForExist({ timeout: 30_000 })
    await selectFile("blank.pdf", blankPdf())
    await renderedPage()
  })

  // Chinese rather than Latin on purpose: it is the case that has to subset and
  // embed a font, and the one that renders as empty boxes when that goes wrong.
  it("types a Chinese note onto the page, and undo takes it back off", async () => {
    const clean = await pageInk()

    await $("button[aria-label='Add a note']").click()
    await expect($("button[aria-label='Add a note']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    await clickOnPage()

    const editor = await $("textarea[aria-label='Note text']")
    await editor.waitForDisplayed({ timeout: 15_000 })
    await editor.setValue("你好")

    // The font choice gives way as soon as the note leaves Latin-1, because the
    // bundled face is the only one that can draw it, and the editor says so.
    await expect(
      $("p=Chinese and other non-Latin text uses the bundled font."),
    ).toBeDisplayed()

    await $("button[aria-label='Add this note']").click()

    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 20_000,
      timeoutMsg: "the note never reached the page",
    })

    const drawn = await pageInk()

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await pageInk()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the note back off the page",
    })

    // Exact, so a redo that ran the command twice would fail rather than pass
    // for carrying "more ink than clean".
    await $("button[aria-label='Redo']").click()
    await browser.waitUntil(async () => (await pageInk()) === drawn, {
      timeout: 15_000,
      timeoutMsg: "redo did not restore the note exactly",
    })
  })

  // Two different strings must not draw the same picture. They would if the
  // embedded subset lost its character map, which renders every note as an
  // identical row of empty boxes — accepted, saved, and quite unreadable.
  it("draws different Chinese text differently", async () => {
    const inkOf = async (text: string) => {
      await clickOnPage()

      const editor = await $("textarea[aria-label='Note text']")
      await editor.waitForDisplayed({ timeout: 15_000 })
      await editor.setValue(text)
      await $("button[aria-label='Add this note']").click()
      await browser.pause(2500)

      const ink = await pageInk()

      await $("button[aria-label='Undo']").click()
      await browser.pause(2000)

      return ink
    }

    await $("button[aria-label='Add a note']").click()

    const hello = await inkOf("你好")
    const other = await inkOf("一二")

    expect(hello).toBeGreaterThan(0)
    expect(hello).not.toBe(other)
  })

  // An editor closed without a word in it is not an edit. Otherwise a stray
  // click with the tool on would record an undo step that changed nothing.
  it("keeps an empty note off the page and out of the history", async () => {
    const clean = await pageInk()

    await $("button[aria-label='Add a note']").click()
    await clickOnPage()
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })

    await $("button[aria-label='Discard this note']").click()
    await browser.pause(2500)

    await expect($("button[aria-label='Undo']")).toBeDisabled()
    expect(await pageInk()).toBe(clean)
  })

  // Placing a note while one is open swaps the draft inside a single render
  // rather than remounting the editor, so a caret that only arrived on mount
  // would leave every note after the first needing a click before it could be
  // typed into.
  it("puts the caret in each note placed in a row", async () => {
    await $("button[aria-label='Add a note']").click()

    await clickOnPage(0.3, 0.3)
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })
    await browser.pause(500)

    await clickOnPage(0.3, 0.6)
    await browser.pause(1500)

    const focused = await browser.execute(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    )

    expect(focused).toBe("Note text")
  })

  // The editor floats in screen space, so nothing moves it when the page moves.
  // Zooming resizes the page by writing its own CSS width, which fires neither
  // a scroll nor a window resize when the page already fits — so an editor that
  // listened only for those drifted away from the point it was pinned to.
  it("stays pinned to its point through a zoom", async () => {
    const offsetFromClickPoint = () =>
      browser.execute(() => {
        const page = document.querySelector("[data-page-number='1']")!
        const box = page.getBoundingClientRect()
        const editor = document
          .querySelector("textarea[aria-label='Note text']")!
          .getBoundingClientRect()

        return {
          dx: Math.round(editor.left - (box.left + box.width * 0.3)),
          dy: Math.round(editor.top - (box.top + box.height * 0.3)),
          pageWidth: Math.round(box.width),
        }
      })

    await $("button[aria-label='Add a note']").click()
    await clickOnPage(0.3, 0.3)
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })
    await browser.pause(800)

    const before = await offsetFromClickPoint()

    await pressControl("button[aria-label='Zoom out']")
    await browser.pause(400)
    await pressControl("button[aria-label='Zoom out']")
    await browser.pause(1800)

    const after = await offsetFromClickPoint()

    // The page really did change size, or this would prove nothing.
    expect(after.pageWidth).toBeLessThan(before.pageWidth)
    expect(after.dx).toBe(before.dx)
    expect(after.dy).toBe(before.dy)
  })

  // The options sit above the text box, which puts them off the top of the
  // window for a note placed near the top of the page — where they cannot be
  // reached or even seen. They drop below the box instead.
  it("keeps the options on screen for a note near the top of the page", async () => {
    const optionsBox = () =>
      browser.execute(() => {
        const label = [...document.querySelectorAll("p")].find(
          (node) => node.textContent === "Text colour",
        )!
        const panel = label.closest("div")!.parentElement!.getBoundingClientRect()
        const textarea = document
          .querySelector("textarea[aria-label='Note text']")!
          .getBoundingClientRect()

        return { panelTop: Math.round(panel.top), textareaTop: Math.round(textarea.top) }
      })

    await $("button[aria-label='Add a note']").click()

    // Near the very top of the page, where there is no room above.
    await clickOnPage(0.3, 0.02)
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })
    await browser.pause(900)

    const box = await optionsBox()

    expect(box.panelTop).toBeGreaterThan(0)
    expect(box.panelTop).toBeGreaterThan(box.textareaTop)
  })

  // Reaching for zoom or rotate is not finishing the note. Closing on any press
  // outside the viewer threw an empty note away the moment the reader zoomed in
  // to place it accurately, and committed a half-typed one.
  it("survives a press on the viewer controls", async () => {
    await $("button[aria-label='Add a note']").click()
    await clickOnPage(0.3, 0.4)
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })
    await browser.pause(500)

    await pressControl("button[aria-label='Rotate clockwise']")
    await browser.pause(1200)

    await expect($("textarea[aria-label='Note text']")).toBeDisplayed()
  })

  // A right-click is not a placement. Without the guard it closed the open note,
  // opened another, and swallowed the gesture it was meant for.
  it("ignores a non-primary press", async () => {
    const clean = await pageInk()

    await $("button[aria-label='Add a note']").click()

    await browser.execute(() => {
      const page = document.querySelector("[data-page-number='1']")!
      const box = page.getBoundingClientRect()
      page.querySelector("canvas")!.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 2,
          clientX: box.left + box.width * 0.3,
          clientY: box.top + box.height * 0.3,
          isPrimary: true,
        }),
      )
    })
    await browser.pause(1200)

    await expect($("textarea[aria-label='Note text']")).not.toBeDisplayed()
    expect(await pageInk()).toBe(clean)
  })


  // The zh-CN interface, since a Chinese note is the case this tool exists for
  // and its reader is the one most likely to be running the app in Chinese.
  it("adds a note through the Chinese interface", async () => {
    await browser.execute((key) => {
      window.localStorage.setItem(key, "zh-CN")
    }, languageStorageKey)
    await browser.refresh()
    await $("input[aria-label='选择 PDF 文件']").waitForExist({ timeout: 30_000 })
    await selectFile("blank.pdf", blankPdf())
    await renderedPage()

    const clean = await pageInk()

    await $("button[aria-label='添加文字注释']").click()
    await clickOnPage()

    const editor = await $("textarea[aria-label='注释文字']")
    await editor.waitForDisplayed({ timeout: 15_000 })
    await editor.setValue("批注")
    await $("button[aria-label='添加此注释']").click()

    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 20_000,
      timeoutMsg: "the note never reached the page",
    })
  })
})
