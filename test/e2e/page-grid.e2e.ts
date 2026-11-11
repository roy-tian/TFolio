import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  bandedPdf,
  openPdfFromDisk,
  outlinedPdf,
  refreshApp,
  seedSettings,
  settingsHold,
} from "./helpers"

const session = "[data-document-session][data-active='true']"
const grid = `${session} [data-page-thumbnails='grid']`
const handle = `${activeSidebar} [data-slot='sidebar-resize']`
const preview = (scope: string, pageNumber: number) =>
  `${scope} button[data-thumbnail-page='${pageNumber}']`

async function showGrid() {
  await $(`${session} button[aria-label='Thumbnails']`).click()
  await $(grid).waitForExist()
}

function sidebarWidth() {
  return browser.execute(
    (selector: string) => document.querySelector(selector)!.getBoundingClientRect().width,
    activeSidebar,
  )
}

function columns(scope: string) {
  return browser.execute(
    (within: string) =>
      Number(
        document
          .querySelector(`${within} [data-thumbnail-columns]`)
          ?.getAttribute("data-thumbnail-columns"),
      ),
    scope,
  )
}

function pageCount(scope: string) {
  return browser.execute(
    (within: string) => document.querySelectorAll(`${within} button[data-thumbnail-page]`).length,
    scope,
  )
}

/** Page numbers row by row, as the grid lays them out on screen. */
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
  }, grid)
}

/** The widest a docked sidebar goes here: the toolbar beside it keeps the room
    it has in the narrowest docked window. */
function widestDocked() {
  return browser.execute(() => window.innerWidth - (1100 - 256))
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
    preview(grid, from),
    preview(grid, target),
  )
}

/** Each page's ink, top to bottom of its band: a banded page names itself. */
function bandOrder(scope: string) {
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

async function settledBands(scope: string, count: number) {
  let previous: number[] = []
  let current: number[] = []

  await browser.waitUntil(
    async () => {
      previous = current
      current = await bandOrder(scope)

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
    grid,
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
    grid,
  )
}

function shape(pageNumber: number) {
  return browser.execute((selector: string) => {
    const box = document.querySelector(selector)!.getBoundingClientRect()

    return box.width > box.height ? "landscape" : "portrait"
  }, preview(grid, pageNumber))
}

function pageStatus() {
  return $(`${session} [data-slot='page-status']`).getAttribute("aria-label")
}

describe("TFolio page grid", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("keeps the sidebar to one column however wide, and its width through a reload", async () => {
    await openPdfFromDisk("column.pdf", bandedPdf(4))
    await settledBands(activeSidebar, 4)

    const opening = await sidebarWidth()

    // An arrow press on the focused edge widens it a step.
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)!.focus()
    }, handle)
    await browser.keys("ArrowRight")
    await browser.waitUntil(async () => (await sidebarWidth()) === opening + 16)

    // Dragged far past the window's room, it stops where the toolbar keeps its own.
    const widest = await widestDocked()
    await dragEdge(900)
    await browser.waitUntil(async () => Math.round(await sidebarWidth()) === widest, {
      timeoutMsg: "the sidebar never settled at its widest",
    })
    expect(await columns(activeSidebar)).toBe(1)
    // Down the sidebar a page is found, not edited: no controls of its own.
    expect(
      await browser.execute(
        (scope: string) => document.querySelectorAll(`${scope} [data-page-action]`).length,
        activeSidebar,
      ),
    ).toBe(0)
    await settingsHold([`sidebarWidth = ${widest}`])

    // Esc takes a drag back to where it started.
    await dragEdge(-120, true)
    expect(Math.round(await sidebarWidth())).toBe(widest)

    await refreshApp()
    await openPdfFromDisk("column.pdf", bandedPdf(4))
    await browser.waitUntil(async () => Math.round(await sidebarWidth()) === widest, {
      timeoutMsg: "the stored width did not come back",
    })
  })

  it("lays the pages out over the reading view, which a double-click goes back to", async () => {
    await openPdfFromDisk("grid.pdf", bandedPdf(6))
    await showGrid()
    await browser.waitUntil(async () => (await pageCount(grid)) === 6)

    const across = await columns(grid)
    expect(across).toBeGreaterThan(2)
    expect((await rows())[0]).toEqual(Array.from({ length: across }, (_, index) => index + 1))
    // The pages are in the grid, so the sidebar keeps to the bookmarks; the
    // reading view's scale and drawing tools have nothing to act on.
    await expect($(`${activeSidebar} [data-page-thumbnails]`)).not.toExist()
    await expect($(`${session} [data-slot='zoom-controls']`)).not.toExist()
    await expect($(`${session} button[aria-label='Highlight text']`)).toBeDisabled()

    // A click chooses, and the grid stays.
    await $(preview(grid, 5)).click()
    expect(await selectedThumbs()).toEqual([5])
    await expect($(grid)).toExist()

    // Enter opens the focused page, as a double-click does.
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)!.focus()
    }, preview(grid, 3))
    await browser.keys("Enter")
    await $(grid).waitForExist({ reverse: true })
    await browser.waitUntil(async () => (await pageStatus()) === "Page 3 of 6", {
      timeoutMsg: "Enter never opened page 3",
    })
    await showGrid()

    // WebDriver makes no double-click of its own.
    await browser.execute((selector: string) => {
      document
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }))
    }, preview(grid, 5))
    await $(grid).waitForExist({ reverse: true })
    await browser.waitUntil(async () => (await pageStatus()) === "Page 5 of 6", {
      timeoutMsg: "the reading view never came back on page 5",
    })
    await expect($(`${session} [data-slot='zoom-controls']`)).toExist()
  })

  it("opens the next document on the grid while the reader last left one there", async () => {
    await openPdfFromDisk("first.pdf", bandedPdf(2))
    await showGrid()
    await settingsHold(["pageGrid = true"])

    // A document of its own, opened in a tab of its own.
    await openPdfFromDisk("second.pdf", bandedPdf(3))
    await $(grid).waitForExist()
    await browser.waitUntil(async () => (await pageCount(grid)) === 3)

    await $(`${session} button[aria-label='Single page']`).click()
    await $(grid).waitForExist({ reverse: true })
    await settingsHold(["pageGrid = false"])
    await openPdfFromDisk("third.pdf", bandedPdf(1))
    await $(`${session} [data-page-number='1']`).waitForExist()
    await expect($(grid)).not.toExist()
  })

  it("goes to a bookmark's page beside the grid, which follows and chooses it", async () => {
    await openPdfFromDisk("outlined.pdf", outlinedPdf())
    await showGrid()
    await $(`${activeSidebar} nav[aria-label='Bookmarks']`).waitForExist()

    await browser.execute((scope: string) => {
      Array.from(document.querySelectorAll<HTMLElement>(`${scope} nav[aria-label='Bookmarks'] button`))
        .find((button) => button.textContent?.includes("Second half"))!
        .click()
    }, activeSidebar)
    await browser.waitUntil(async () => (await selectedThumbs()).join() === "2", {
      timeoutMsg: "the bookmark's page was never chosen",
    })
    await expect($(grid)).toExist()
  })

  it("drags a page across a row of the grid", async () => {
    await openPdfFromDisk("grid-drag.pdf", bandedPdf(4))
    await showGrid()
    const [first, second, third, fourth] = await settledBands(grid, 4)

    await dragThumbBefore(4, 1)
    await browser.waitUntil(
      async () => (await bandOrder(grid)).join() === [fourth, first, second, third].join(),
      { timeout: 15_000, timeoutMsg: "the dragged page never landed first" },
    )

    await browser.keys(["Control", "z"])
    await browser.waitUntil(
      async () => (await bandOrder(grid)).join() === [first, second, third, fourth].join(),
      { timeout: 15_000, timeoutMsg: "undo never put the page back" },
    )
  })

  it("turns, removes and chooses one page by its own controls", async () => {
    await openPdfFromDisk("controls.pdf", bandedPdf(4))
    await showGrid()
    await settledBands(grid, 4)

    await pressControl(2, "[data-page-action='toggle']")
    await pressControl(3, "[data-page-action='toggle']")
    expect(await selectedThumbs()).toEqual([2, 3])

    // A page's own turn is that page's alone, chosen or not.
    await pressControl(4, "[data-page-action='rotate-right']")
    await browser.waitUntil(async () => (await shape(4)) === "landscape")
    expect(await shape(2)).toBe("portrait")
    expect(await shape(3)).toBe("portrait")

    await pressControl(1, "[data-page-action='delete']")
    await browser.waitUntil(async () => (await pageCount(grid)) === 3, {
      timeoutMsg: "the page's own delete never took it",
    })

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await pageCount(grid)) === 4)
  })

  it("inserts a blank page from the gap between two pages", async () => {
    await openPdfFromDisk("gaps.pdf", bandedPdf(3))
    await showGrid()
    const [first, second, third] = await settledBands(grid, 3)

    await pressControl(2, "[data-insert-gap='before']")
    await browser.waitUntil(async () => (await pageCount(grid)) === 4, {
      timeoutMsg: "the gap's blank never came in",
    })
    await browser.waitUntil(
      async () => (await bandOrder(grid)).join() === [first, 0, second, third].join(),
      { timeout: 15_000, timeoutMsg: "the blank is not between the first two pages" },
    )

    // The last page's gap after it adds at the end.
    await pressControl(4, "[data-insert-gap='after']")
    await browser.waitUntil(async () => (await pageCount(grid)) === 5)
  })
})
