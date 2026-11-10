import { browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  bandedPdf,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
  settingsHold,
} from "./helpers"

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
    (scope: string) =>
      Number(
        document
          .querySelector(`${scope} [data-thumbnail-columns]`)
          ?.getAttribute("data-thumbnail-columns"),
      ),
    activeSidebar,
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
  }, activeSidebar)
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
    preview(from),
    preview(target),
  )
}

/** Each page's ink, top to bottom of its band: a banded page names itself. */
function bandOrder() {
  return browser.execute((scope: string) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`${scope} button[data-thumbnail-page]`),
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
  }, activeSidebar)
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
function pressControl(pageNumber: number, action: string) {
  return browser.execute(
    (scope: string, page: number, name: string) => {
      const cell = document
        .querySelector(`${scope} button[data-thumbnail-page='${page}']`)!
        .closest("li")!
      const control = cell.querySelector<HTMLElement>(`[data-page-action='${name}']`)!

      control.focus()
      control.click()
    },
    activeSidebar,
    pageNumber,
    action,
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

describe("TFolio sidebar widened into a grid", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("widens by its edge into columns, and keeps the width through a reload", async () => {
    await openPdfFromDisk("grid.pdf", bandedPdf(4))
    await settledBands(4)

    const opening = await sidebarWidth()
    expect(await columns()).toBe(1)

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
    await browser.waitUntil(async () => (await columns()) === 2)
    expect(await rows()).toEqual([
      [1, 2],
      [3, 4],
    ])
    // Widened, the previews painted in one column stay painted.
    await settledBands(4)
    await settingsHold([`sidebarWidth = ${widest}`])

    // Esc takes a drag back to where it started.
    await dragEdge(-120, true)
    expect(Math.round(await sidebarWidth())).toBe(widest)

    await refreshApp()
    await openPdfFromDisk("grid.pdf", bandedPdf(4))
    await browser.waitUntil(async () => (await columns()) === 2, {
      timeoutMsg: "the stored width did not come back",
    })
    expect(Math.round(await sidebarWidth())).toBe(widest)
  })

  it("drags a page across a row of the grid", async () => {
    await seedSettings({ ui: { language: "en", sidebarWidth: 900, viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("grid-drag.pdf", bandedPdf(4))
    await browser.waitUntil(async () => (await columns()) === 2)
    const [first, second, third, fourth] = await settledBands(4)

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

    await pressControl(2, "toggle")
    await pressControl(3, "toggle")
    expect(await selectedThumbs()).toEqual([2, 3])

    // A page's own turn is that page's alone, chosen or not.
    await pressControl(4, "rotate-right")
    await browser.waitUntil(async () => (await shape(4)) === "landscape")
    expect(await shape(2)).toBe("portrait")
    expect(await shape(3)).toBe("portrait")

    await pressControl(1, "delete")
    await browser.waitUntil(
      async () =>
        browser.execute(
          (scope: string) =>
            document.querySelectorAll(`${scope} button[data-thumbnail-page]`).length,
          activeSidebar,
        ).then((count) => count === 3),
      { timeoutMsg: "the page's own delete never took it" },
    )

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () =>
      browser
        .execute(
          (scope: string) =>
            document.querySelectorAll(`${scope} button[data-thumbnail-page]`).length,
          activeSidebar,
        )
        .then((count) => count === 4),
    )
  })
})
