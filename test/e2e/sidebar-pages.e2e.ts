import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  bandedPdf,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
  settingsHold,
} from "./helpers"

const session = "[data-document-session][data-active='true']"
const handle = `${activeSidebar} [data-slot='sidebar-resize']`
const preview = (pageNumber: number) =>
  `${activeSidebar} button[data-thumbnail-page='${pageNumber}']`

function sidebarWidth() {
  return browser.execute(
    (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width,
    activeSidebar,
  )
}

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

function pageCount() {
  return browser.execute(
    (within: string) => document.querySelectorAll(`${within} button[data-thumbnail-page]`).length,
    activeSidebar,
  )
}

/** Page numbers row by row, as the sidebar lays them out on screen. */
function rows() {
  return browser.execute((scope: string) => {
    const lines = new Map<number, number[]>()

    for (const button of document.querySelectorAll<HTMLElement>(
      `${scope} button[data-thumbnail-page]`,
    )) {
      const cell = button.closest("li")!.getBoundingClientRect()
      const top = Math.round(cell.top)

      lines.set(top, [...(lines.get(top) ?? []), Number(button.dataset.thumbnailPage)])
    }

    return [...lines.entries()].sort(([a], [b]) => a - b).map(([, pages]) => pages)
  }, activeSidebar)
}

/** The widest a docked sidebar goes here: the pages beside it keep the room
    they have in the narrowest docked window. */
function widestDocked() {
  return browser.execute(() => window.innerWidth - 640)
}

/** A reader's drag of the sidebar's edge, sent as the pointer events a press,
    a move and a release make; `escape` presses Esc before letting go. */
function dragEdge(by: number, escape = false) {
  return browser.execute(
    (selector: string, distance: number, cancel: boolean) => {
      const edge = document.querySelector<HTMLElement>(selector)!
      const box = edge.getBoundingClientRect()
      const start = { x: box.left + box.width / 2, y: box.top + 200 }

      edge.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: start.x,
          clientY: start.y,
          isPrimary: true,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: start.x + distance,
          clientY: start.y,
        }),
      )

      if (cancel) {
        document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
      }

      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: start.x + distance,
          clientY: start.y,
        }),
      )
    },
    handle,
    by,
    escape,
  )
}

/** Over the left edge of the target's cell is the gap before it. */
function dragThumbBefore(from: number, target: number) {
  return browser.execute(
    (fromSelector: string, targetSelector: string) => {
      const source = document.querySelector(fromSelector)!
      const fromBox = source.getBoundingClientRect()
      const targetBox = document.querySelector(targetSelector)!.getBoundingClientRect()
      const start = { x: fromBox.left + fromBox.width / 2, y: fromBox.top + fromBox.height / 2 }
      const dest = { x: targetBox.left + 6, y: targetBox.top + targetBox.height / 2 }

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

/** Each page's ink, top to bottom of its band: a banded page names itself. */
function bandOrder(scope = activeSidebar) {
  return browser.execute((within: string) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`${within} button[data-thumbnail-page]`),
      (button) => {
        const canvas = button.querySelector("canvas")!
        const copy = document.createElement("canvas")
        copy.width = canvas.width
        copy.height = canvas.height
        const context = copy.getContext("2d")!
        context.drawImage(canvas, 0, 0)
        const { data } = context.getImageData(0, 0, copy.width, copy.height)
        let hash = 0

        for (let index = 0; index < data.length; index += 4) {
          if (765 - data[index]! - data[index + 1]! - data[index + 2]! > 30) {
            hash = (hash * 31 + index) % 1_000_000_007
          }
        }

        return hash
      },
    )
  }, scope)
}

async function settledBands(count: number) {
  let previous: number[] = []
  let current: number[] = []

  await browser.waitUntil(
    async () => {
      previous = current
      current = await bandOrder()

      return (
        current.length === count &&
        new Set(current).size === count &&
        current.every((hash) => hash > 0) &&
        current.join() === previous.join()
      )
    },
    { timeout: 30_000, timeoutMsg: "the previews never painted" },
  )

  return current
}

/** A page's own control, pressed as the keyboard would: its bar shows only
    under a real pointer, which the driver cannot make. */
function pressControl(pageNumber: number, control: string) {
  return browser.execute(
    (scope: string, page: number, name: string) => {
      const cell = document
        .querySelector(`${scope} button[data-thumbnail-page='${page}']`)!
        .closest("li")!
      const pressed = cell.querySelector<HTMLElement>(name)!

      pressed.focus()
      pressed.click()
    },
    activeSidebar,
    pageNumber,
    control,
  )
}

function selectedThumbs() {
  return browser.execute(
    (scope: string) =>
      Array.from(
        document.querySelectorAll(`${scope} button[data-thumbnail-page][aria-pressed='true']`),
        (button) => Number(button.getAttribute("data-thumbnail-page")),
      ).sort((left, right) => left - right),
    activeSidebar,
  )
}

function shape(pageNumber: number) {
  return browser.execute((selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()

    return box.width > box.height ? "landscape" : "portrait"
  }, preview(pageNumber))
}

function pageStatus() {
  return $(`${session} [data-slot='page-status']`).getAttribute("aria-label")
}

/** Wide enough for rows of two, and no wider than the suite's window lets a
    docked sidebar go. */
const TWO_COLUMNS = 440

describe("TFolio sidebar pages", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("widens from one column into rows of pages, and keeps its width through a reload", async () => {
    await openPdfFromDisk("column.pdf", bandedPdf(4))
    await settledBands(4)

    const opening = await sidebarWidth()
    expect(await columns()).toBe(1)

    // An arrow press on the focused edge widens it a step.
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)!.focus()
    }, handle)
    await browser.keys("ArrowRight")
    await browser.waitUntil(async () => (await sidebarWidth()) === opening + 16)

    // Dragged far past the window's room, it stops where the pages keep their own.
    const widest = await widestDocked()
    await dragEdge(900)
    await browser.waitUntil(async () => Math.round(await sidebarWidth()) === widest, {
      timeoutMsg: "the sidebar never settled at its widest",
    })
    await browser.waitUntil(async () => (await columns()) === 3, {
      timeoutMsg: "the widened sidebar never laid its pages out in rows",
    })
    expect(await rows()).toEqual([[1, 2, 3], [4]])
    await settingsHold([`sidebarWidth = ${widest}`])

    // Esc takes a drag back to where it started.
    await dragEdge(-120, true)
    expect(Math.round(await sidebarWidth())).toBe(widest)

    await refreshApp()
    await openPdfFromDisk("column.pdf", bandedPdf(4))
    await browser.waitUntil(async () => Math.round(await sidebarWidth()) === widest, {
      timeoutMsg: "the stored width did not come back",
    })
    expect(await columns()).toBe(3)
  })

  it("goes to the page a click chooses, the pages to read staying beside it", async () => {
    await openPdfFromDisk("read.pdf", bandedPdf(6))
    await $(preview(5)).waitForExist({ timeout: 30_000 })

    await $(preview(5)).click()
    expect(await selectedThumbs()).toEqual([5])
    await browser.waitUntil(async () => (await pageStatus()) === "Page 5 of 6", {
      timeoutMsg: "the click never went to page 5",
    })
    // The pages are worked on beside the view they are read in, which keeps
    // its scale, its turn and its drawing tools: there is no view of the
    // pages alone to switch to.
    await expect($(`${session} [data-slot='zoom-controls']`)).toExist()
    await expect($(`${session} button[aria-label='Highlight text']`)).toBeEnabled()
    await expect($$(`${session} [aria-label='View mode'] button`)).toBeElementsArrayOfSize(2)
  })

  it("drags a page across a row of the widened sidebar", async () => {
    await seedSettings({ ui: { language: "en", sidebarWidth: TWO_COLUMNS, viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("row-drag.pdf", bandedPdf(4))
    const [first, second, third, fourth] = await settledBands(4)
    expect(await columns()).toBe(2)

    await dragThumbBefore(4, 1)
    await browser.waitUntil(
      async () => (await bandOrder()).join() === [fourth, first, second, third].join(),
      { timeout: 15_000, timeoutMsg: "the dragged page never landed first" },
    )

    await browser.keys(["Control", "z"])
    await browser.waitUntil(
      async () => (await bandOrder()).join() === [first, second, third, fourth].join(),
      { timeout: 15_000, timeoutMsg: "undo never put the page back" },
    )
  })

  it("turns, removes and chooses one page by its own controls", async () => {
    await openPdfFromDisk("controls.pdf", bandedPdf(4))
    await settledBands(4)

    await pressControl(2, "[data-page-action='toggle']")
    await pressControl(3, "[data-page-action='toggle']")
    expect(await selectedThumbs()).toEqual([2, 3])
    // A tick only adds to the choice: the reader stays on the page they read.
    expect(await pageStatus()).toBe("Page 1 of 4")

    // A page's own turn is that page's alone, chosen or not.
    await pressControl(4, "[data-page-action='rotate-right']")
    await browser.waitUntil(async () => (await shape(4)) === "landscape")
    expect(await shape(2)).toBe("portrait")
    expect(await shape(3)).toBe("portrait")

    await pressControl(1, "[data-page-action='delete']")
    await browser.waitUntil(async () => (await pageCount()) === 3, {
      timeoutMsg: "the page's own delete never took it",
    })

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await pageCount()) === 4)
  })

  for (const layout of ["down the column", "across a row"] as const) {
    it(`inserts a blank page from the gap before a page, ${layout}`, async () => {
      if (layout === "across a row") {
        await seedSettings({
          ui: { language: "en", sidebarWidth: TWO_COLUMNS, viewMode: "single" },
        })
        await refreshApp()
      }

      await openPdfFromDisk("gaps.pdf", bandedPdf(3))
      const [first, second, third] = await settledBands(3)
      expect(await columns()).toBe(layout === "across a row" ? 2 : 1)

      await pressControl(2, "[data-insert-gap='before']")
      await browser.waitUntil(async () => (await pageCount()) === 4, {
        timeoutMsg: "the gap's blank never came in",
      })
      await browser.waitUntil(
        async () => (await bandOrder()).join() === [first, 0, second, third].join(),
        { timeout: 15_000, timeoutMsg: "the blank is not between the first two pages" },
      )

      // The last page's gap after it adds at the end.
      await pressControl(4, "[data-insert-gap='after']")
      await browser.waitUntil(async () => (await pageCount()) === 5)
    })
  }
})
