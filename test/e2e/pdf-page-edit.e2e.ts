import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  appMenuItemEnabled,
  bandedPdf,
  clickAppMenuItem,
  openPathViaDialog,
  openPdfFromDisk,
  pressRedo,
  refreshApp,
  seedSettings,
  sidebarPageAction,
} from "./helpers"

/** Only the active document's sidebar is laid out, and only it is what a
    gesture means — a hidden tab's column is still in the tree. */
const preview = (pageNumber: number) =>
  `${activeSidebar} button[data-thumbnail-page='${pageNumber}']`

function thumbCount() {
  return browser.execute(
    (scope: string) =>
      document.querySelectorAll(`${scope} button[data-thumbnail-page]`).length,
    activeSidebar,
  )
}

/**
 * A position-sensitive digest of one preview's pixels. -1 no preview; -2 a
 * canvas not yet painted (solid black would pass for heavy ink); 0 a blank.
 */
function thumbFingerprint(pageNumber: number) {
  return browser.execute((selector: string) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`${selector} canvas`)

    if (!canvas) {
      return -1
    }

    // A `bitmaprenderer` canvas has no 2d context to read: copy it into one.
    const copy = document.createElement("canvas")
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext("2d")!
    context.drawImage(canvas, 0, 0)
    const { data } = context.getImageData(0, 0, copy.width, copy.height)
    let hash = 0
    let ink = 0
    let whites = 0

    for (let index = 0; index < data.length; index += 4) {
      const darkness = 765 - data[index]! - data[index + 1]! - data[index + 2]!

      if (darkness > 30) {
        hash = (hash * 31 + index) % 1_000_000_007
        ink += darkness
      } else {
        whites += 1
      }
    }

    if (whites === 0) {
      return -2
    }

    return ink > 0 ? hash : 0
  }, preview(pageNumber))
}

async function waitForThumb(pageNumber: number, fingerprint: number) {
  await browser.waitUntil(
    async () => (await thumbFingerprint(pageNumber)) === fingerprint,
    { timeout: 15_000, timeoutMsg: `preview ${pageNumber} never showed the expected page` },
  )
}

async function paintedFingerprints(pageCount: number) {
  const fingerprints: number[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    // Sizing a canvas clears it, so a first paint can read blank a moment
    // after; two equal readings say the bitmap has settled.
    let previous = -1
    let settled = -1

    await browser.waitUntil(
      async () => {
        const current = await thumbFingerprint(pageNumber)
        const painted = current >= 0 && current === previous

        previous = current
        settled = current

        return painted
      },
      { timeout: 30_000, timeoutMsg: `preview ${pageNumber} never painted` },
    )
    fingerprints.push(settled)
  }

  expect(new Set(fingerprints).size).toBe(pageCount)

  return fingerprints
}

/**
 * A click with modifiers, dispatched rather than driven: WebDriver's own click
 * cannot hold Ctrl or Shift down for it. Focused first, as a real press does,
 * which is what hands the column the clipboard keys.
 */
function clickThumb(
  pageNumber: number,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
) {
  return browser.execute(
    (selector: string, mods: { ctrl?: boolean; shift?: boolean }) => {
      const button = document.querySelector<HTMLElement>(selector)!

      button.focus()
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          ctrlKey: Boolean(mods.ctrl),
          shiftKey: Boolean(mods.shift),
        }),
      )
    },
    preview(pageNumber),
    modifiers,
  )
}

function selectedThumbs() {
  return browser.execute(
    (scope: string) =>
      Array.from(
        document.querySelectorAll(
          `${scope} button[data-thumbnail-page][aria-pressed='true']`,
        ),
        (button) => Number(button.getAttribute("data-thumbnail-page")),
      ).sort((left, right) => left - right),
    activeSidebar,
  )
}

function thumbShape(pageNumber: number) {
  return browser.execute((selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()

    return box.width > box.height ? "landscape" : "portrait"
  }, preview(pageNumber))
}

/**
 * A reader's drag — press, move past the threshold, release over the top of
 * the target — dispatched as pointer events, the only press semantics a test
 * has under WebKitGTK. Over the top half is the gap before the target page.
 */
function dragThumbBefore(from: number, target: number) {
  return browser.execute(
    (fromSelector: string, targetSelector: string) => {
      const source = document.querySelector(fromSelector)!
      const fromBox = source.getBoundingClientRect()
      const targetBox = document.querySelector(targetSelector)!.getBoundingClientRect()
      const start = { x: fromBox.left + fromBox.width / 2, y: fromBox.top + fromBox.height / 2 }
      const dest = { x: targetBox.left + targetBox.width / 2, y: targetBox.top + 6 }

      source.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: start.x,
          clientY: start.y,
          isPrimary: true,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: start.x, clientY: start.y + 12 }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: dest.x, clientY: dest.y }),
      )
      document.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: dest.x, clientY: dest.y }),
      )
    },
    preview(from),
    preview(target),
  )
}

const pageInput = () => $("input[aria-label='Page number']")

describe("TFolio page editing in the sidebar", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("chooses pages with click, Ctrl+click and Shift+click, a plain click going there", async () => {
    await openPdfFromDisk("select.pdf", bandedPdf(4))
    await paintedFingerprints(4)

    await clickThumb(2)
    expect(await selectedThumbs()).toEqual([2])
    await expect(pageInput()).toHaveValue("2")

    // Adding to the choice leaves the reader where they are.
    await clickThumb(4, { ctrl: true })
    expect(await selectedThumbs()).toEqual([2, 4])
    await expect(pageInput()).toHaveValue("2")

    // The toggle moved the anchor to 4, so Shift spans 1 through 4.
    await clickThumb(1, { shift: true })
    expect(await selectedThumbs()).toEqual([1, 2, 3, 4])

    await browser.keys("Escape")
    expect(await selectedThumbs()).toEqual([])
  })

  it("turns a chosen page in the document, undoably", async () => {
    await openPdfFromDisk("rotate.pdf", bandedPdf(3))
    await paintedFingerprints(3)

    await clickThumb(2)
    await sidebarPageAction(2, "rotate-pages")
    await browser.waitUntil(async () => (await thumbShape(2)) === "landscape", {
      timeoutMsg: "the page never turned",
    })
    expect(await thumbShape(1)).toBe("portrait")

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await thumbShape(2)) === "portrait")
    await pressRedo()
    await browser.waitUntil(async () => (await thumbShape(2)) === "landscape")
  })

  it("deletes the chosen page with the Delete key, and undo and redo answer", async () => {
    await openPdfFromDisk("delete.pdf", bandedPdf(3))
    const [first, second, third] = await paintedFingerprints(3)

    await clickThumb(2)
    await browser.keys("Delete")
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the delete never landed",
    })
    await waitForThumb(1, first!)
    await waitForThumb(2, third!)

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await thumbCount()) === 3)
    await waitForThumb(2, second!)

    await pressRedo()
    await browser.waitUntil(async () => (await thumbCount()) === 2)
  })

  it("inserts blank pages before and after a page", async () => {
    await openPdfFromDisk("blank.pdf", bandedPdf(2))
    const [first, second] = await paintedFingerprints(2)

    await sidebarPageAction(1, "insert-blank-before")
    await browser.waitUntil(async () => (await thumbCount()) === 3)
    await waitForThumb(1, 0)
    await waitForThumb(2, first!)

    await sidebarPageAction(3, "insert-blank-after")
    await browser.waitUntil(async () => (await thumbCount()) === 4)
    await waitForThumb(3, second!)
    await waitForThumb(4, 0)
  })

  it("cuts a page and pastes it before another as one move", async () => {
    await openPdfFromDisk("cut.pdf", bandedPdf(3))
    const [first, second, third] = await paintedFingerprints(3)

    await clickThumb(3)
    await browser.keys(["Control", "x"])
    await $("[data-notice='pagesCut']").waitForDisplayed()
    await clickThumb(1)
    await browser.keys(["Control", "v"])

    await waitForThumb(1, third!)
    await waitForThumb(2, first!)
    await waitForThumb(3, second!)

    await browser.keys(["Control", "z"])
    await waitForThumb(1, first!)
    await waitForThumb(3, third!)
  })

  it("copies a page and pastes the copy before another", async () => {
    await openPdfFromDisk("copy.pdf", bandedPdf(2))
    const [first, second] = await paintedFingerprints(2)

    await clickThumb(1)
    await browser.keys(["Control", "c"])
    await $("[data-notice='pagesCopied']").waitForDisplayed()
    await clickThumb(2)
    await browser.keys(["Control", "v"])

    await browser.waitUntil(async () => (await thumbCount()) === 3)
    await waitForThumb(1, first!)
    await waitForThumb(2, first!)
    await waitForThumb(3, second!)

    // The last page's menu is the one way past the end.
    await sidebarPageAction(3, "paste-pages-end")
    await browser.waitUntil(async () => (await thumbCount()) === 4)
    await waitForThumb(4, first!)
  })

  it("leaves the clipboard keys to the text while the column is not focused", async () => {
    await openPdfFromDisk("keys.pdf", bandedPdf(2))
    await paintedFingerprints(2)

    await clickThumb(1)
    await browser.execute(() => {
      document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] [data-pdf-scroll-root]",
      )!.focus()
    })
    await browser.keys(["Control", "x"])

    await expect($("[data-notice='pagesCut']")).not.toBeExisting()
  })

  it("drags a page to another place in the column", async () => {
    await openPdfFromDisk("reorder.pdf", bandedPdf(4))
    const [first, second, third, fourth] = await paintedFingerprints(4)

    await dragThumbBefore(4, 2)
    await waitForThumb(1, first!)
    await waitForThumb(2, fourth!)
    await waitForThumb(3, second!)
    await waitForThumb(4, third!)

    await browser.keys(["Control", "z"])
    await waitForThumb(2, second!)
    await waitForThumb(4, fourth!)
  })

  it("saves the edited structure into the file itself", async () => {
    const filePath = await openPdfFromDisk("restructure.pdf", bandedPdf(4))
    const [, second, , fourth] = await paintedFingerprints(4)

    await clickThumb(1)
    await browser.keys("Delete")
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the delete never landed",
    })
    await dragThumbBefore(3, 1)
    await waitForThumb(1, fourth!)

    await clickAppMenuItem("save")
    await browser.waitUntil(async () => !(await appMenuItemEnabled("save")), {
      timeoutMsg: "the save never completed",
    })

    await refreshApp()
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await openPathViaDialog(filePath)
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the reopened file lost its shape",
    })
    await waitForThumb(1, fourth!)
    await waitForThumb(2, second!)
  })
})
