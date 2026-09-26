import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  blankPdf,
  dropZoneButton,
  openPdfFromDisk,
  pageInk,
  refreshApp,
  renderedPage,
  seedSettings,
} from "./helpers"

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
 * WebDriver's click fires neither `pointerdown` nor `mousedown` here, so a test
 * asserting a note survives (or not) a press sends the real press itself.
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
    // Type in the default style, whatever a prior run persisted.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("blank.pdf", blankPdf())
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

    await $("button[aria-label='Add this note']").click()

    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 20_000,
      timeoutMsg: "the note never reached the page",
    })

    const drawn = await pageInk()

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await pageInk()) === clean, {
      timeout: 15_000,
      timeoutMsg: "undo did not take the note back off the page",
    })

    // Exact, so a redo that ran the command twice would fail rather than pass
    // for carrying "more ink than clean".
    await $("button[aria-label^='Redo']").click()
    await browser.waitUntil(async () => (await pageInk()) === drawn, {
      timeout: 15_000,
      timeoutMsg: "redo did not restore the note exactly",
    })
  })

  // They would draw the same if the embedded subset lost its character map —
  // every note an identical row of empty boxes, accepted, saved, unreadable.
  it("draws different Chinese text differently", async () => {
    const inkOf = async (text: string) => {
      await clickOnPage()

      const editor = await $("textarea[aria-label='Note text']")
      await editor.waitForDisplayed({ timeout: 15_000 })
      await editor.setValue(text)
      // The mark reaches the canvas as a repaint, so the ink moving off the
      // pre-add baseline — and back to it on undo — is the commit itself.
      const baseline = await pageInk()
      await $("button[aria-label='Add this note']").click()
      await browser.waitUntil(
        async () => (await pageInk()) !== baseline,
        { timeout: 15_000, timeoutMsg: "the note never reached the canvas" },
      )
      const ink = await pageInk()

      await $("button[aria-label^='Undo']").click()
      await browser.waitUntil(
        async () => (await pageInk()) === baseline,
        { timeout: 15_000, timeoutMsg: "undo never restored the canvas" },
      )

      return ink
    }

    await $("button[aria-label='Add a note']").click()

    const hello = await inkOf("你好")
    const other = await inkOf("一二")

    expect(hello).toBeGreaterThan(0)
    expect(hello).not.toBe(other)
  })

  // The note must stay on screen from confirm until the page repaints carrying
  // it — PDFium, IPC and a decode sit between, and closing early blanked the text.
  for (const note of [{ label: "Latin", text: "Note gy" }, { label: "Chinese", text: "你好" }]) {
    it(`hands the ${note.label} note to the page without a blank or doubled frame`, async () => {
      // Large, so a wrong ascent is points off rather than a fraction of one.
      await seedSettings({
        annotate: { textNote: { color: "#000000", fontSize: 48, opacity: 1 } },
        ui: { language: "en", viewMode: "single" },
      })
      await refreshApp()
      await dropZoneButton().waitForExist({ timeout: 30_000 })
      await openPdfFromDisk("blank.pdf", blankPdf())
      await renderedPage()

      await $("button[aria-label='Add a note']").click()
      await clickOnPage()

      const editor = await $("textarea[aria-label='Note text']")
      await editor.waitForDisplayed({ timeout: 15_000 })
      await editor.setValue(note.text)

      const result = await browser.executeAsync((done: (result: {
        blankFrames: number
        canvasWidth: number
        doubled: boolean
        landed: boolean
        previewInkTop: number
        renderedInkTop: number
        waitingFrames: number
      }) => void) => {
        const page = document.querySelector("[data-page-number='1']")!
        const source = page.querySelector<HTMLCanvasElement>("canvas")!
        const clean = source.toDataURL()
        const selector = "[data-slot='text-note-preview']"
        const frame = () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        )
        // Where the note's ink starts, in the page's own points: the canvas is
        // rendered at some multiple of the 300x400 page.
        const inkTop = () => {
          const { data } = source.getContext("2d")!.getImageData(
            0, 0, source.width, source.height,
          )

          for (let y = 0; y < source.height; y += 1) {
            for (let x = 0; x < source.width; x += 1) {
              const at = (y * source.width + x) * 4

              if (765 - data[at]! - data[at + 1]! - data[at + 2]! > 160) {
                return y / (source.width / 300)
              }
            }
          }

          return Number.NaN
        }

        void (async () => {
          // Only decoding is delayed — IPC, PDFium and history stay real; a fix
          // that merely kept the editor open would double the text once landed.
          const decode = window.createImageBitmap.bind(window)
          window.createImageBitmap = (async (...args: Parameters<typeof decode>) => {
            const bitmap = await decode(...args)
            await new Promise((resolve) => setTimeout(resolve, 400))
            return bitmap
          }) as typeof window.createImageBitmap

          let blankFrames = 0
          let waitingFrames = 0
          let doubled = false
          let landed = false
          let previewInkTop = Number.NaN
          try {
            document.querySelector<HTMLButtonElement>(
              "button[aria-label='Add this note']",
            )!.click()

            const deadline = performance.now() + 25_000
            while (performance.now() < deadline) {
              await frame()
              const preview = page.querySelector(selector)
              const changed = source.toDataURL() !== clean

              if (!changed) {
                waitingFrames += 1
                if (preview) {
                  // The preview's baseline less the face's own ink ascent — an
                  // element box gives only the ascent that placed the baseline.
                  const line = preview.querySelector("text")!
                  const size = Number(line.getAttribute("font-size"))
                  const context = document.createElement("canvas").getContext("2d")!
                  context.font = `100px ${line.getAttribute("font-family")}`
                  previewInkTop =
                    Number(line.getAttribute("y")) -
                    (context.measureText(line.textContent!).actualBoundingBoxAscent /
                      100) *
                      size
                } else if (!document.querySelector("textarea[aria-label='Note text']")) {
                  blankFrames += 1
                }
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

          // Let the render settle before the ink is measured.
          await new Promise((resolve) => setTimeout(resolve, 1000))
          done({
            blankFrames,
            canvasWidth: source.width,
            doubled,
            landed,
            previewInkTop,
            renderedInkTop: inkTop(),
            waitingFrames,
          })
        })()
      })

      expect(result.waitingFrames).toBeGreaterThan(2)
      expect(result.blankFrames).toBe(0)
      expect(result.doubled).toBe(false)
      expect(result.landed).toBe(true)
      // Four points clears the cap-height difference between PDFium's Helvetica
      // and the browser's stand-in (~1.5); the wrong face's error would be ten.
      expect(Math.abs(result.previewInkTop - result.renderedInkTop)).toBeLessThan(4)
      await browser.saveScreenshot(
        `artifacts/e2e/text-note-${note.label.toLowerCase()}.png`,
      )
    })
  }

  // An editor closed without a word in it is not an edit. Otherwise a stray
  // click with the tool on would record an undo step that changed nothing.
  it("keeps an empty note off the page and out of the history", async () => {
    const clean = await pageInk()

    await $("button[aria-label='Add a note']").click()
    await clickOnPage()
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })

    await $("button[aria-label='Discard this note']").click()
    await browser.pause(2500)

    await expect($("button[aria-label^='Undo']")).toBeDisabled()
    expect(await pageInk()).toBe(clean)
  })

  // A reader may undo while partway through the next note; an undo that moves
  // no page must leave the open draft to be finished, not discard it.
  it("keeps an open note draft when an undo takes back an earlier note", async () => {
    const editor = () => $("textarea[aria-label='Note text']")

    await $("button[aria-label='Add a note']").click()

    await clickOnPage(0.3, 0.3)
    await editor().waitForDisplayed({ timeout: 15_000 })
    await editor().setValue("first")
    await $("button[aria-label='Add this note']").click()
    // Landed in history before the second note opens, so the undo below has a
    // deterministic target rather than racing the first note's commit.
    await $("button[aria-label^='Undo']").waitForEnabled({ timeout: 15_000 })

    await clickOnPage(0.3, 0.6)
    await editor().waitForDisplayed({ timeout: 15_000 })
    await editor().setValue("second")

    // A real press, so the note tool's own listener runs (it leaves an off-page
    // press alone); then undo takes back the first note.
    await pressControl("button[aria-label^='Undo']")

    await expect(editor()).toBeDisplayed()
    await expect($("button[aria-label^='Undo']")).toBeDisabled()
  })

  // A placement swaps the draft in a single render, not a remount, so a caret
  // that only arrived on mount would strand every note after the first.
  it("puts the caret in each note placed in a row", async () => {
    await $("button[aria-label='Add a note']").click()

    await clickOnPage(0.3, 0.3)
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })
    await browser.pause(500)

    await clickOnPage(0.3, 0.6)
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.activeElement?.getAttribute("aria-label") ?? null,
        )) === "Note text",
      { timeout: 5_000, timeoutMsg: "the second placement never took the caret" },
    )

    const focused = await browser.execute(
      () => document.activeElement?.getAttribute("aria-label") ?? null,
    )

    expect(focused).toBe("Note text")
  })

  // Zooming writes the page's CSS width, firing neither scroll nor window resize
  // when the page already fits — an editor listening only for those drifted off.
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
    // The editor re-pins a beat after the page relays out, so the shrunk page
    // alone is not enough: the offset has to stop moving as well.
    await browser.waitUntil(
      async () => {
        const first = await offsetFromClickPoint()
        await browser.pause(300)
        const again = await offsetFromClickPoint()
        return (
          again.pageWidth < before.pageWidth &&
          again.dx === first.dx &&
          again.dy === first.dy
        )
      },
      { timeout: 10_000, timeoutMsg: "the zoom never relaid out the page" },
    )

    const after = await offsetFromClickPoint()

    // The page really did change size, or this would prove nothing.
    expect(after.pageWidth).toBeLessThan(before.pageWidth)
    expect(after.dx).toBe(before.dx)
    expect(after.dy).toBe(before.dy)
  })

  // Above the text box, the options sit off the top of the window for a note
  // near the page's top — unreachable, unseen — so they drop below the box.
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

  // Reaching for zoom or rotate is not finishing the note: closing on any press
  // outside the viewer threw away drafts the moment a reader zoomed to place.
  it("survives a press on the viewer controls", async () => {
    await $("button[aria-label='Add a note']").click()
    await clickOnPage(0.3, 0.4)
    await $("textarea[aria-label='Note text']").waitForDisplayed({ timeout: 15_000 })
    await browser.pause(500)

    // The rotation commits as the page box flipping to the rotated footprint;
    // the bitmap repaints behind it at an unchanged canvas size.
    const pageBox = () =>
      browser.execute(() => {
        const box = document
          .querySelector("[data-page-number='1']")!
          .getBoundingClientRect()
        return `${Math.round(box.width)}x${Math.round(box.height)}`
      })
    const beforeRotate = await pageBox()
    await pressControl("button[aria-label='Rotate the view clockwise']")
    await browser.waitUntil(
      async () => (await pageBox()) !== beforeRotate,
      { timeout: 10_000, timeoutMsg: "the rotation never relaid out the page" },
    )

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
    await seedSettings({ ui: { language: "zh-CN", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPdfFromDisk("blank.pdf", blankPdf())
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
