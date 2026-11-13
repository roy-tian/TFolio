import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  appMenuItem,
  appMenuItemEnabled,
  bandedPdf,
  clickAppMenuItem,
  closeAppMenu,
  contextMenuAction,
  openPathViaDialog,
  openPdfFromDisk,
  pressRedo,
  refreshApp,
  seedSettings,
  sidebarPageAction,
  textPdf,
  tooltipOn,
} from "./helpers"
import type { E2eOverrides } from "../../src/lib/e2e"

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

/** A drag that carries a page over the column and then off it, beside the
    sidebar, before letting go there. */
function dragThumbAway(from: number, over: number) {
  return browser.execute(
    (fromSelector: string, overSelector: string) => {
      const source = document.querySelector(fromSelector)!
      const fromBox = source.getBoundingClientRect()
      const overBox = document.querySelector(overSelector)!.getBoundingClientRect()
      const start = { x: fromBox.left + fromBox.width / 2, y: fromBox.top + fromBox.height / 2 }
      const away = { x: overBox.right + 400, y: overBox.top + 6 }
      const move = (x: number, y: number) =>
        document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y }))

      source.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: start.x,
          clientY: start.y,
          isPrimary: true,
        }),
      )
      move(start.x, start.y + 12)
      move(start.x, overBox.top + 6)
      move(away.x, away.y)
      document.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: away.x, clientY: away.y }),
      )
    },
    preview(from),
    preview(over),
  )
}

type Point = { x: number; y: number }

/** Presses a preview and carries it past the drag threshold, leaving the
    pages in hand for the moves that follow. */
function liftThumb(pageNumber: number) {
  return browser.execute((selector: string) => {
    const source = document.querySelector(selector)!
    const box = source.getBoundingClientRect()
    const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 }

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
  }, preview(pageNumber))
}

function pointerAt(type: "pointermove" | "pointerup", point: Point) {
  return browser.execute(
    (kind: string, at: Point) => {
      document.dispatchEvent(
        new PointerEvent(kind, { bubbles: true, clientX: at.x, clientY: at.y }),
      )
    },
    type,
    point,
  )
}

/** Just inside the top of a preview in the shown sidebar: the gap before it. */
function abovePreview(pageNumber: number) {
  return browser.execute((selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()

    return { x: box.left + box.width / 2, y: box.top + 6 }
  }, preview(pageNumber))
}

function tabPoint(name: string) {
  return browser.execute((tabName: string) => {
    const tab = Array.from(
      document.querySelectorAll<HTMLElement>("[data-document-tab]"),
    ).find((element) => element.textContent?.includes(tabName))!
    const box = tab.getBoundingClientRect()

    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, name)
}

/** The middle of the strip's open space, past the last tab and its buttons. */
function stripSpace() {
  return browser.execute(() => {
    const box = document.querySelector("[data-strip-space]")!.getBoundingClientRect()

    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
}

const tabButton = (name: string) =>
  $(`//button[@role='tab'][normalize-space()='${name}']`)

const pageInput = () => $("input[aria-label='Page number']")

const saveTrigger = "[data-document-session][data-active='true'] [data-slot='pdf-save-trigger']"

/** Focus in the column with no page pressed: where the keys are the pages'
    while nothing is chosen. */
function focusColumn() {
  return browser.execute((scope: string) => {
    document.querySelector<HTMLElement>(`${scope} [data-slot='sidebar-thumbnails']`)!.focus()
  }, activeSidebar)
}

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

    const toolbar = "[data-document-session][data-active='true'] [data-slot='toolbar']"
    const save = $(`${toolbar} [data-slot='pdf-save-trigger']`)

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await thumbShape(2)) === "portrait")
    await $(`${toolbar} button[aria-label^='Redo']`).click()
    await browser.waitUntil(async () => (await thumbShape(2)) === "landscape")
    await expect(save).toBeEnabled()

    // Turned back by hand, not undone: the file already holds this.
    await sidebarPageAction(2, "rotate-pages-left")
    await browser.waitUntil(async () => (await thumbShape(2)) === "portrait", {
      timeoutMsg: "the page never turned back",
    })
    await expect(save).toBeDisabled()
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

  it("takes the page being read with the Delete and clipboard keys while none is chosen", async () => {
    await openPdfFromDisk("reading-keys.pdf", bandedPdf(3))
    const [, second, third] = await paintedFingerprints(3)

    // What the bar over the pages names, the keys take too: page 1.
    await focusColumn()
    await browser.keys("Delete")
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the Delete key never took the page being read",
    })
    await waitForThumb(1, second!)

    await browser.keys(["Control", "c"])
    await $("[data-notice='pagesCopied']").waitForDisplayed()
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the paste never landed after the page being read",
    })
    await waitForThumb(1, second!)
    await waitForThumb(2, second!)
    await waitForThumb(3, third!)
    expect(await selectedThumbs()).toEqual([2])
  })

  it("moves the choice with the arrow keys, and stretches it with Shift", async () => {
    await openPdfFromDisk("arrows.pdf", bandedPdf(4))
    await paintedFingerprints(4)

    await clickThumb(1)
    await browser.keys("ArrowDown")
    await browser.waitUntil(async () => (await selectedThumbs()).join() === "2", {
      timeoutMsg: "the arrow never took the choice to the next page",
    })
    // The reader goes with a plain arrow, as with a click.
    await expect(pageInput()).toHaveValue("2")

    await browser.keys(["Shift", "ArrowDown"])
    await browser.waitUntil(async () => (await selectedThumbs()).join() === "2,3", {
      timeoutMsg: "Shift never stretched the choice",
    })
    // Stretching the choice leaves the reader where they are.
    await expect(pageInput()).toHaveValue("2")

    await browser.keys("ArrowUp")
    await browser.waitUntil(async () => (await selectedThumbs()).join() === "2", {
      timeoutMsg: "the arrow never left the far end of the choice",
    })
  })

  it("offers a page its menu in the reading view, for that page alone", async () => {
    await openPdfFromDisk("reading-menu.pdf", bandedPdf(3))
    await paintedFingerprints(3)

    // A choice in the sidebar is no part of it.
    await clickThumb(2)
    await clickThumb(3, { ctrl: true })
    await contextMenuAction(
      "[data-document-session][data-active='true'] [data-page-number='1']",
      "rotate-pages",
    )
    await browser.waitUntil(async () => (await thumbShape(1)) === "landscape", {
      timeoutMsg: "the page pressed in the reading view never turned",
    })
    expect(await thumbShape(2)).toBe("portrait")
    expect(await thumbShape(3)).toBe("portrait")
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

  it("cuts a page and pastes it after another as one move", async () => {
    await openPdfFromDisk("cut.pdf", bandedPdf(3))
    const [first, second, third] = await paintedFingerprints(3)

    await clickThumb(3)
    await browser.keys(["Control", "x"])
    await $("[data-notice='pagesCut']").waitForDisplayed()
    await clickThumb(1)
    await browser.keys(["Control", "v"])

    await waitForThumb(1, first!)
    await waitForThumb(2, third!)
    await waitForThumb(3, second!)

    await browser.keys(["Control", "z"])
    await waitForThumb(1, first!)
    await waitForThumb(3, third!)
  })

  it("copies a page and pastes the copy after another, chosen where it landed", async () => {
    await openPdfFromDisk("copy.pdf", bandedPdf(2))
    const [first, second] = await paintedFingerprints(2)

    await clickThumb(1)
    await browser.keys(["Control", "c"])
    await $("[data-notice='pagesCopied']").waitForDisplayed()
    await clickThumb(2)
    await browser.keys(["Control", "v"])

    await browser.waitUntil(async () => (await thumbCount()) === 3)
    await waitForThumb(1, first!)
    await waitForThumb(2, second!)
    await waitForThumb(3, first!)
    // The copy is the choice now: the key pastes again after it.
    await expect($(`${activeSidebar} button[data-thumbnail-page='3']`)).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 4)
    await waitForThumb(4, first!)

    // The menu's other entry is the one way in front of the first page.
    await sidebarPageAction(1, "paste-pages-before")
    await browser.waitUntil(async () => (await thumbCount()) === 5)
    await waitForThumb(1, first!)
    await waitForThumb(2, first!)
  })

  it("takes a cut back with Esc, wherever the focus is", async () => {
    await openPdfFromDisk("cut-escape.pdf", bandedPdf(3))
    await paintedFingerprints(3)
    const cutPages = () =>
      browser.execute(
        (scope: string) =>
          Array.from(
            document.querySelectorAll(`${scope} [data-cut] [data-thumbnail-page]`),
            (button) => Number(button.getAttribute("data-thumbnail-page")),
          ),
        activeSidebar,
      )

    await sidebarPageAction(3, "cut-pages")
    await browser.waitUntil(async () => (await cutPages()).join() === "3", {
      timeoutMsg: "the cut page never faded",
    })
    await browser.execute(() => {
      document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] [data-pdf-scroll-root]",
      )!.focus()
    })
    // While the menu's popup is still leaving, the keys are its own.
    await browser.waitUntil(() =>
      browser.execute(() => !document.querySelector("[role='menu']")),
    )
    await browser.keys("Escape")
    await browser.waitUntil(async () => (await cutPages()).length === 0, {
      timeoutMsg: "Esc never took the cut back",
    })
    await $("[data-notice='pagesCut']").waitForExist({ reverse: true, timeout: 5_000 })
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

  it("puts a page back that is let go beside the column", async () => {
    await openPdfFromDisk("put-back.pdf", bandedPdf(4))
    const painted = await paintedFingerprints(4)

    await dragThumbAway(1, 3)
    // The ghost flies home before the drag lets the column go.
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !document.querySelector("[data-drag-ghost]") &&
            !document.querySelector("[data-drag-hole]"),
        ),
      { timeoutMsg: "the drag never settled" },
    )
    // A reorder still in flight shows in this order alone: until it lands, each
    // preview keeps its old page number, and with it its old fingerprint.
    expect(
      await browser.execute(
        (scope: string) =>
          Array.from(
            document.querySelectorAll(`${scope} button[data-thumbnail-page]`),
            (button) => Number(button.getAttribute("data-thumbnail-page")),
          ),
        activeSidebar,
      ),
    ).toEqual([1, 2, 3, 4])

    for (const [index, fingerprint] of painted.entries()) {
      expect(await thumbFingerprint(index + 1)).toBe(fingerprint)
    }
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

  it("turns the pages a paste brings in with the rest of a turned view", async () => {
    await openPdfFromDisk("turned.pdf", bandedPdf(2))
    await paintedFingerprints(2)
    await $("button[aria-label='Rotate the view clockwise']").click()
    await browser.waitUntil(async () => (await thumbShape(2)) === "landscape", {
      timeoutMsg: "the view never turned",
    })

    await clickThumb(2)
    await browser.keys(["Control", "c"])
    await clickThumb(1)
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the paste never landed",
    })

    // The last place is the one an untracked turn would have left upright.
    for (const pageNumber of [1, 2, 3]) {
      expect(await thumbShape(pageNumber)).toBe("landscape")
    }
  })
})

describe("TFolio pages carried to other documents", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("copies pages into another tab's column where they are let go", async () => {
    await openPdfFromDisk("carry-target.pdf", textPdf(2))
    const [targetFirst, targetSecond] = await paintedFingerprints(2)
    await openPdfFromDisk("carry-source.pdf", bandedPdf(4))
    const [, sourceSecond, sourceThird] = await paintedFingerprints(4)

    await clickThumb(2)
    await clickThumb(3, { ctrl: true })
    await liftThumb(3)
    await pointerAt("pointermove", await tabPoint("carry-target.pdf"))
    await expect($("[data-append-offer]")).toHaveText("+2")
    // Resting on the tab opens it under the pages.
    await expect(tabButton("carry-target.pdf")).toHaveAttribute("aria-selected", "true")

    const gap = await abovePreview(2)

    await pointerAt("pointermove", gap)
    await $(`${activeSidebar} [data-drag-hole]`).waitForExist({
      timeoutMsg: "the column never made room for the pages",
    })
    await expect($("[data-append-offer]")).not.toBeExisting()
    await pointerAt("pointerup", gap)

    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the copies never landed",
    })
    await waitForThumb(1, targetFirst!)
    await waitForThumb(2, sourceSecond!)
    await waitForThumb(3, sourceThird!)
    await waitForThumb(4, targetSecond!)

    // One step in the history of the document that took them.
    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the undo never took the copies back",
    })

    // The source gave copies and kept its own.
    await tabButton("carry-source.pdf").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the source lost pages",
    })
  })

  it("adds pages let go on another tab to the end of its file", async () => {
    await openPdfFromDisk("append-target.pdf", textPdf(2))
    const [targetFirst, targetSecond] = await paintedFingerprints(2)
    await openPdfFromDisk("append-source.pdf", bandedPdf(4))
    const [first, , third] = await paintedFingerprints(4)

    await clickThumb(1)
    await clickThumb(3, { ctrl: true })
    await liftThumb(3)

    // In one script, so the release lands well before the tab would open.
    const tab = await tabPoint("append-target.pdf")

    await browser.execute((at: Point) => {
      for (const kind of ["pointermove", "pointerup"]) {
        document.dispatchEvent(
          new PointerEvent(kind, { bubbles: true, clientX: at.x, clientY: at.y }),
        )
      }
    }, tab)

    await $("[data-notice='pagesAppended']").waitForDisplayed({
      timeoutMsg: "the copies never landed",
    })
    await expect($("[data-notice='pagesAppended']")).toHaveText(
      expect.stringContaining("Added 2 pages to the end of append-target.pdf"),
    )
    await expect(tabButton("append-source.pdf")).toHaveAttribute("aria-selected", "true")
    expect(await thumbCount()).toBe(4)

    await tabButton("append-target.pdf").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the target never showed the copies",
    })
    await waitForThumb(1, targetFirst!)
    await waitForThumb(2, targetSecond!)
    await waitForThumb(3, first!)
    await waitForThumb(4, third!)
    await expect(
      $("button[role='tab'][aria-selected='true'] [aria-label='Unsaved changes']"),
    ).toBeExisting()

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the undo never took the copies back",
    })
  })

  it("refuses pages let go on a tab still at work, and says so", async () => {
    await openPdfFromDisk("busy-target.pdf", textPdf(2))
    await paintedFingerprints(2)
    // A Save As whose dialog is never answered holds the tab's queue.
    await browser.execute(() => {
      const page = window as Window & {
        __finishSaveAs?: () => void
        __tfolioE2E?: E2eOverrides
      }

      page.__tfolioE2E = {
        ...page.__tfolioE2E,
        exportPdf: () =>
          new Promise((resolve) => {
            page.__finishSaveAs = () => resolve(null)
          }),
      }
    })
    await clickAppMenuItem("save-as")
    await browser.waitUntil(
      () =>
        browser.execute(
          () => typeof (window as Window & { __finishSaveAs?: unknown }).__finishSaveAs === "function",
        ),
      { timeoutMsg: "the Save As never started" },
    )

    await openPdfFromDisk("busy-source.pdf", bandedPdf(4))
    await paintedFingerprints(4)
    await clickThumb(1)
    await liftThumb(1)

    const tab = await tabPoint("busy-target.pdf")

    await pointerAt("pointermove", tab)
    // The spring and the offer are set by the same move.
    await $("[data-tab-spring]").waitForExist()
    await expect($("[data-append-offer]")).not.toBeExisting()
    await pointerAt("pointerup", tab)

    await $("[data-notice='pagesAppendBusy']").waitForDisplayed()
    await expect($("[data-notice='pagesAppendBusy']")).toHaveText(
      expect.stringContaining("busy-target.pdf still has work in progress"),
    )

    // Once the work is done, the same release adds the page.
    await browser.execute(() =>
      (window as Window & { __finishSaveAs?: () => void }).__finishSaveAs?.(),
    )
    await tabButton("busy-source.pdf").click()
    // The refused pages fly home first; a press before then lifts nothing.
    // Carried out they left no hole to watch: the column says while it is
    // still in a drag.
    await $(`${activeSidebar} [data-pages-dragging]`).waitForExist({ reverse: true })
    await clickThumb(1)
    await liftThumb(1)
    // The tab is asked on each move, as a held pointer's tremor would.
    await browser.waitUntil(
      async () => {
        await pointerAt("pointermove", tab)
        return $("[data-append-offer]").isExisting()
      },
      { timeoutMsg: "the tab never offered itself once its work was done" },
    )
    await expect($("[data-append-offer]")).toHaveText("+1")
    await pointerAt("pointerup", tab)

    // The same corner slot: the success replaces the refusal.
    await $("[data-notice='pagesAppended']").waitForDisplayed()
    await expect($("[data-notice='pagesAppendBusy']")).not.toBeExisting()
    await tabButton("busy-target.pdf").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the page never landed once the tab was free",
    })
  })

  it("makes a new PDF of pages let go on the tab strip's open space", async () => {
    await openPdfFromDisk("extract-source.pdf", bandedPdf(4))
    const [first, , third] = await paintedFingerprints(4)

    await clickThumb(1)
    await clickThumb(3, { ctrl: true })
    await liftThumb(3)

    const space = await stripSpace()

    await pointerAt("pointermove", space)
    await $("[data-new-document-offer]").waitForDisplayed({
      timeoutMsg: "the strip never offered a new PDF",
    })
    // Copied, never taken: carried out, the pages show where they stand.
    await expect($(`${activeSidebar} [data-drag-hole]`)).not.toBeExisting()
    await pointerAt("pointerup", space)

    await expect(tabButton("Pages from extract-source.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the new PDF never showed its pages",
    })
    await waitForThumb(1, first!)
    await waitForThumb(2, third!)
    // Work that exists nowhere else yet: a close asks first.
    await expect(
      $("button[role='tab'][aria-selected='true'] [aria-label='Unsaved changes']"),
    ).toBeExisting()
    // With no file of its own to write back to, its save button is Save As.
    await expect($(saveTrigger)).toHaveAttribute("data-save-as-only", "")
    await expect($(saveTrigger)).toBeEnabled()

    await tabButton("extract-source.pdf").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the source lost pages",
    })
  })

  it("makes a new PDF of the chosen pages from their menu", async () => {
    await openPdfFromDisk("menu-extract.pdf", bandedPdf(3))
    const [first, , third] = await paintedFingerprints(3)

    await clickThumb(1)
    await clickThumb(3, { ctrl: true })
    await sidebarPageAction(3, "extract-pages")

    await expect(tabButton("Pages from menu-extract.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the new PDF never showed its pages",
    })
    await waitForThumb(1, first!)
    await waitForThumb(2, third!)
  })

  it("pastes pages copied in another tab, and takes pages cut there out of it", async () => {
    await openPdfFromDisk("paste-target.pdf", textPdf(2))
    await paintedFingerprints(2)
    await openPdfFromDisk("paste-source.pdf", bandedPdf(3))
    const [sourceFirst, sourceSecond] = await paintedFingerprints(3)

    await clickThumb(2)
    await browser.keys(["Control", "c"])
    await $("[data-notice='pagesCopied']").waitForDisplayed()
    await tabButton("paste-target.pdf").click()
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the other tab never showed",
    })
    await clickThumb(1)
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the copy never crossed to the other document",
    })
    await waitForThumb(2, sourceSecond!)

    // A cut is a move: pasted there, the page leaves the document it was cut in.
    await tabButton("paste-source.pdf").click()
    await expect(tabButton("paste-source.pdf")).toHaveAttribute("aria-selected", "true")
    await clickThumb(1)
    await browser.keys(["Control", "x"])
    await $("[data-notice='pagesCut']").waitForDisplayed()
    await tabButton("paste-target.pdf").click()
    await expect(tabButton("paste-target.pdf")).toHaveAttribute("aria-selected", "true")
    await clickThumb(1)
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the cut page never crossed to the other document",
    })
    await waitForThumb(2, sourceFirst!)

    await tabButton("paste-source.pdf").click()
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the cut page never left the document it was cut in",
    })
  })

  it("takes a cut pasted elsewhere out of its document once work under way there ends", async () => {
    await openPdfFromDisk("saved-target.pdf", textPdf(2))
    await paintedFingerprints(2)
    await openPdfFromDisk("saving-source.pdf", bandedPdf(3))
    const [sourceFirst] = await paintedFingerprints(3)

    await clickThumb(1)
    await browser.keys(["Control", "x"])
    await $("[data-notice='pagesCut']").waitForDisplayed()

    // A Save As whose dialog is never answered holds the source's queue:
    // work under way there that moves no page.
    await browser.execute(() => {
      const page = window as Window & {
        __finishSaveAs?: () => void
        __tfolioE2E?: E2eOverrides
      }

      page.__tfolioE2E = {
        ...page.__tfolioE2E,
        exportPdf: () =>
          new Promise((resolve) => {
            page.__finishSaveAs = () => resolve(null)
          }),
      }
    })
    await clickAppMenuItem("save-as")
    await browser.waitUntil(
      () =>
        browser.execute(
          () => typeof (window as Window & { __finishSaveAs?: unknown }).__finishSaveAs === "function",
        ),
      { timeoutMsg: "the Save As never started" },
    )

    await tabButton("saved-target.pdf").click()
    await expect(tabButton("saved-target.pdf")).toHaveAttribute("aria-selected", "true")
    await clickThumb(1)
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the cut page never crossed to the other document",
    })
    await waitForThumb(2, sourceFirst!)
    await $("[data-notice='pagesPasted']").waitForDisplayed()

    // Queued behind the save, not dropped for it: the page leaves once it ends.
    await browser.execute(() =>
      (window as Window & { __finishSaveAs?: () => void }).__finishSaveAs?.(),
    )
    await tabButton("saving-source.pdf").click()
    await expect(tabButton("saving-source.pdf")).toHaveAttribute("aria-selected", "true")
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the cut page never left the document it was cut in",
    })
  })

  it("pastes a cut of every page its document has as copies, and says they stay", async () => {
    await openPdfFromDisk("whole-target.pdf", textPdf(2))
    await paintedFingerprints(2)
    await openPdfFromDisk("whole-source.pdf", bandedPdf(2))
    const [sourceFirst, sourceSecond] = await paintedFingerprints(2)

    await clickThumb(1)
    await clickThumb(2, { shift: true })
    await browser.keys(["Control", "x"])
    await $("[data-notice='pagesCut']").waitForDisplayed()
    await tabButton("whole-target.pdf").click()
    await expect(tabButton("whole-target.pdf")).toHaveAttribute("aria-selected", "true")
    await clickThumb(2)
    await browser.keys(["Control", "v"])
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the cut pages never crossed to the other document",
    })
    await waitForThumb(3, sourceFirst!)
    await waitForThumb(4, sourceSecond!)
    await $("[data-notice='pagesCutKept']").waitForDisplayed()
    await expect($("[data-notice='pagesCutKept']")).toHaveText(
      expect.stringContaining("whole-source.pdf keeps all of its own"),
    )

    // Spent all the same: nothing there shows as cut any more.
    await tabButton("whole-source.pdf").click()
    await expect(tabButton("whole-source.pdf")).toHaveAttribute("aria-selected", "true")
    expect(await thumbCount()).toBe(2)
    await expect($(`${activeSidebar} [data-cut]`)).not.toBeExisting()
  })

  it("refuses to paste pages whose own document has an edit in flight, and says so", async () => {
    await openPdfFromDisk("idle-target.pdf", textPdf(2))
    await paintedFingerprints(2)
    await openPdfFromDisk("edited-source.pdf", bandedPdf(4))
    await paintedFingerprints(4)

    await clickThumb(2)
    await browser.keys(["Control", "c"])
    await $("[data-notice='pagesCopied']").waitForDisplayed()

    // A Save As whose dialog is never answered holds the source's queue, and
    // a delete waits behind it: an edit in flight, about to renumber the
    // pages the clipboard names.
    await browser.execute(() => {
      const page = window as Window & {
        __finishSaveAs?: () => void
        __tfolioE2E?: E2eOverrides
      }

      page.__tfolioE2E = {
        ...page.__tfolioE2E,
        exportPdf: () =>
          new Promise((resolve) => {
            page.__finishSaveAs = () => resolve(null)
          }),
      }
    })
    await clickAppMenuItem("save-as")
    await browser.waitUntil(
      () =>
        browser.execute(
          () => typeof (window as Window & { __finishSaveAs?: unknown }).__finishSaveAs === "function",
        ),
      { timeoutMsg: "the Save As never started" },
    )
    await clickThumb(1)
    await browser.keys("Delete")

    await tabButton("idle-target.pdf").click()
    await expect(tabButton("idle-target.pdf")).toHaveAttribute("aria-selected", "true")
    await clickThumb(1)
    await browser.keys(["Control", "v"])

    await $("[data-notice='pagesAppendBusy']").waitForDisplayed()
    await expect($("[data-notice='pagesAppendBusy']")).toHaveText(
      expect.stringContaining("edited-source.pdf still has work in progress"),
    )
    expect(await thumbCount()).toBe(2)

    await browser.execute(() =>
      (window as Window & { __finishSaveAs?: () => void }).__finishSaveAs?.(),
    )
  })

  it("keeps a new PDF of watermarked pages export-only", async () => {
    await openPdfFromDisk("stamped-source.pdf", bandedPdf(2))
    await paintedFingerprints(2)
    await $("button[aria-label='Watermark']").click()
    await $("[data-testid='watermark-text']").setValue("ARCHIVE")
    await $("[data-testid='watermark-apply']").click()
    await $("[data-testid='watermark-dialog']").waitForDisplayed({
      reverse: true,
      timeout: 30_000,
    })

    await clickThumb(1)
    await liftThumb(1)

    const space = await stripSpace()

    await pointerAt("pointermove", space)
    await $("[data-new-document-offer]").waitForDisplayed()
    await pointerAt("pointerup", space)
    await expect(tabButton("Pages from stamped-source.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    // The tab knows from its first render, before any edit has said so.
    const save = await appMenuItem("save")
    expect(await save.getAttribute("data-disabled")).not.toBe(null)
    expect(await tooltipOn("[data-action='save']")).toContain("holding copies of pages")
    await closeAppMenu(save)
  })
})
