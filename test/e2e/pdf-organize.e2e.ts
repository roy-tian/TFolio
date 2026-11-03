import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import {
  clickAppMenuItem,
  emitDrag,
  minimalPdf,
  outlinedPdf,
  pointMultiPickerAt,
  pressRedo,
  refreshApp,
  seedSettings,
  writeScratchPdf,
} from "./helpers"

const workspace = "[data-organize-workspace]"
const sidebar = `${workspace} [data-slot='app-sidebar']`

// Portrait pages for one file, landscape for the other: the assembled
// document's page shapes then say which file each page came from.
const portrait = () => writeScratchPdf("portrait.pdf", minimalPdf(2, "0 0 200 300"))
const landscape = () => writeScratchPdf("landscape.pdf", minimalPdf(3, "0 0 300 200"))

async function organizeWith(paths: string[]) {
  await $("button[aria-label='Organize pages']").click()
  await $(`${workspace} [data-slot='organize-empty-add']`).waitForDisplayed()
  await pointMultiPickerAt(paths)
  await $(`${workspace} [data-slot='organize-empty-add']`).click()
  await browser.waitUntil(
    async () => (await groupCount()) === paths.length,
    { timeout: 30_000, timeoutMsg: "the picked files never reached the board" },
  )
}

async function groupCount() {
  return (await $$(`${workspace} section[data-group-id]`).getElements()).length
}

function total() {
  return $(`${workspace} [data-slot='organize-total']`).getText()
}

/** Each slot of a file's section, by the label its paper reads as. */
function slotLabels(fileTitle: string) {
  return browser.execute(
    (scope: string, title: string) =>
      Array.from(
        document.querySelectorAll(
          `${scope} section[aria-label='${title}'] [data-slot-key] :is([data-thumbnail-page], [data-organize-blank])`,
        ),
        (button) => button.getAttribute("aria-label"),
      ),
    workspace,
    fileTitle,
  )
}

function slot(label: string) {
  return $(`${workspace} [data-slot-key] button[aria-label='${label}']`)
}

/** One of the controls a page carries on its own paper. */
function pageControl(label: string, action: string) {
  return $(
    `${workspace} [data-slot-key]:has(button[aria-label='${label}']) [data-page-action='${action}']`,
  )
}

describe("TFolio organize workspace", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("keeps its files while the reader switches to the viewer and back", async () => {
    await organizeWith([portrait(), landscape()])
    await expect(total()).resolves.toBe("5 pages from 2 files")
    await expect($(`${sidebar} [data-slot='organize-files']`)).toHaveText(
      expect.stringContaining("portrait"),
    )

    await $("button[aria-label='View and edit']").click()
    await expect($(workspace)).not.toBeDisplayed()
    await expect($("[data-tab-strip]")).toBeDisplayed()

    await $("button[aria-label='Organize pages']").click()
    await expect($(workspace)).toBeDisplayed()
    expect(await groupCount()).toBe(2)
  })

  it("sizes the thumbnails from the status bar's slider once a file is in", async () => {
    const bar = `${workspace} [data-slot='status-bar']`
    await $("button[aria-label='Organize pages']").click()
    await $(`${workspace} [data-slot='organize-empty-add']`).waitForDisplayed()
    await expect($(`${bar} button[aria-label='Larger thumbnails']`)).toBeDisabled()

    await pointMultiPickerAt([portrait()])
    await $(`${workspace} [data-slot='organize-empty-add']`).click()
    await browser.waitUntil(async () => (await groupCount()) === 1, {
      timeout: 30_000,
      timeoutMsg: "the picked file never reached the board",
    })

    const slider = $(`${bar} input[aria-label='Thumbnail size']`)
    const slotWidth = () =>
      browser.execute((scope: string) =>
        document.querySelector(`${scope} [data-slot-key]`)!.getBoundingClientRect().width,
      workspace)
    await expect(slider).toHaveAttribute("aria-valuetext", "2 of 4")
    const before = await slotWidth()

    await $(`${bar} button[aria-label='Larger thumbnails']`).click()
    await expect(slider).toHaveAttribute("aria-valuetext", "3 of 4")
    expect(await slotWidth()).toBeGreaterThan(before)

    await $(`${bar} button[aria-label='Smaller thumbnails']`).click()
    await $(`${bar} button[aria-label='Smaller thumbnails']`).click()
    await expect(slider).toHaveAttribute("aria-valuetext", "1 of 4")
    await expect($(`${bar} button[aria-label='Smaller thumbnails']`)).toBeDisabled()
    expect(await slotWidth()).toBeLessThan(before)
  })

  it("keeps the status bar's slider in place though it mounted hidden", async () => {
    // The size bar mounts while the workspace is still hidden behind the
    // viewer, before anything could measure its thumb.
    await refreshApp()
    await organizeWith([portrait()])

    const thumb = await browser.execute((scope: string) => {
      const element = document.querySelector<HTMLElement>(
        `${scope} [data-slot='status-bar'] [data-slot='slider-thumb']`,
      )!
      const track = element.parentElement!.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      return {
        at: (box.left + box.width / 2 - track.left) / track.width,
        visibility: window.getComputedStyle(element).visibility,
      }
    }, workspace)
    expect(thumb.visibility).toBe("visible")
    // The second of four sizes sits a third of the way along.
    expect(thumb.at).toBeCloseTo(1 / 3, 1)
  })

  it("moves a page across files and assembles the plan's order", async () => {
    await organizeWith([portrait(), landscape()])

    // Cut a landscape page, choose the second portrait page, paste before it.
    await slot("Page 1 of landscape").click()
    await browser.keys(["Control", "x"])
    await slot("Page 2 of portrait").click()
    await browser.keys(["Control", "v"])

    await browser.waitUntil(
      async () =>
        JSON.stringify(await slotLabels("portrait")) ===
        JSON.stringify(["Page 1 of portrait", "Page 1 of landscape", "Page 2 of portrait"]),
      { timeout: 10_000, timeoutMsg: "the page never moved into the other file" },
    )
    expect(await slotLabels("landscape")).toEqual([
      "Page 2 of landscape",
      "Page 3 of landscape",
    ])

    await $(`${workspace} [data-slot='organize-assemble']`).click()
    await browser.waitUntil(
      async () =>
        (await $("[role='tab'][aria-selected='true']").getText()).includes(
          "Organized.pdf",
        ),
      { timeout: 30_000, timeoutMsg: "the assembled PDF never opened as a tab" },
    )
    await expect($(workspace)).not.toBeDisplayed()
    await expect($("[data-slot='page-status']")).toHaveAttribute(
      "aria-label",
      "Page 1 of 5",
    )

    const shapes = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-document-session][data-active='true'] [data-page-number]",
        ),
        (page) => (page.offsetWidth > page.offsetHeight ? "wide" : "tall"),
      ),
    )
    expect(shapes).toEqual(["tall", "wide", "tall", "wide", "wide"])
  })

  it("drags a page into another file, in before the page it is let go on", async () => {
    await organizeWith([portrait(), landscape()])

    await browser.execute(
      (fromSelector: string, ontoSelector: string) => {
        const source = document.querySelector(fromSelector)!
        const fromBox = source.getBoundingClientRect()
        const ontoBox = document.querySelector(ontoSelector)!.getBoundingClientRect()
        const start = { x: fromBox.left + fromBox.width / 2, y: fromBox.top + fromBox.height / 2 }
        // The page's left half: the stack goes in ahead of it.
        const onto = { x: ontoBox.left + 8, y: ontoBox.top + ontoBox.height / 2 }

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
          new PointerEvent("pointermove", { bubbles: true, clientX: start.x + 12, clientY: start.y }),
        )
        document.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: onto.x, clientY: onto.y }),
        )
        document.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, clientX: onto.x, clientY: onto.y }),
        )
      },
      `${workspace} [data-slot-key] button[aria-label='Page 1 of landscape']`,
      `${workspace} [data-slot-key] button[aria-label='Page 2 of portrait']`,
    )

    await browser.waitUntil(
      async () =>
        JSON.stringify(await slotLabels("portrait")) ===
        JSON.stringify(["Page 1 of portrait", "Page 1 of landscape", "Page 2 of portrait"]),
      { timeout: 10_000, timeoutMsg: "the dragged page never moved into the other file" },
    )
    expect(await slotLabels("landscape")).toEqual([
      "Page 2 of landscape",
      "Page 3 of landscape",
    ])
    await browser.waitUntil(
      async () => browser.execute(() => !document.querySelector("[data-drag-hole]")),
      { timeoutMsg: "the dropped page stayed a hole" },
    )
  })

  it("deletes, turns and inserts pages, each one undo away", async () => {
    await organizeWith([portrait()])

    await slot("Page 1 of portrait").click()
    await $(`${workspace} [data-slot='organize-delete']`).click()
    await expect(total()).resolves.toBe("1 page from 1 file")
    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await total()) === "2 pages from 1 file")
    await pressRedo()
    await browser.waitUntil(async () => (await total()) === "1 page from 1 file")
    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await total()) === "2 pages from 1 file")

    await slot("Page 2 of portrait").click()
    await $(`${workspace} [data-slot='organize-rotate']`).click()
    await expect(slot("Page 2 of portrait")).toHaveAttribute("data-rotation", "90")
    await $(`${workspace} [data-slot='organize-rotate-left']`).click()
    await $(`${workspace} [data-slot='organize-rotate-left']`).click()
    await expect(slot("Page 2 of portrait")).toHaveAttribute("data-rotation", "270")

    await $(`${workspace} [data-slot='organize-insert-blank-before']`).click()
    await expect($(`${workspace} [data-organize-blank]`)).toBeDisplayed()
    await expect(total()).resolves.toBe("3 pages from 1 file")
    await $(`${workspace} [data-slot='organize-insert-blank-after']`).click()
    expect(await slotLabels("portrait")).toEqual([
      "Page 1 of portrait",
      "Blank page",
      "Page 2 of portrait",
      "Blank page",
    ])
  })

  it("lines portrait and landscape pages up in one grid", async () => {
    await organizeWith([portrait(), landscape()])

    const cells = await browser.execute(
      (scope: string) =>
        Array.from(document.querySelectorAll(`${scope} [data-slot-key]`), (cell) => {
          const box = cell.getBoundingClientRect()
          const paper = cell.querySelector("[data-thumbnail-page]")!.getBoundingClientRect()

          return {
            across: Math.round(paper.left + paper.width / 2 - box.left),
            down: Math.round(paper.top + paper.height / 2 - box.top),
            size: `${box.width}x${box.height}`,
          }
        }),
      workspace,
    )

    // Two shapes, one cell: each paper stands in the middle of the same box.
    expect(cells).toHaveLength(5)
    expect(new Set(cells.map((cell) => cell.size)).size).toBe(1)
    expect(new Set(cells.map((cell) => cell.across)).size).toBe(1)
    expect(new Set(cells.map((cell) => cell.down)).size).toBe(1)
  })

  it("turns, ticks and deletes a page from its own controls", async () => {
    await organizeWith([portrait()])

    await pageControl("Page 1 of portrait", "rotate-left").click()
    await expect(slot("Page 1 of portrait")).toHaveAttribute("data-rotation", "270")
    // The page's own bar turned it without choosing it.
    await expect(slot("Page 1 of portrait")).toHaveAttribute("aria-pressed", "false")
    await pageControl("Page 1 of portrait", "rotate-right").click()
    await expect(slot("Page 1 of portrait")).toHaveAttribute("data-rotation", "0")

    await pageControl("Page 1 of portrait", "toggle").click()
    await pageControl("Page 2 of portrait", "toggle").click()
    await expect(slot("Page 1 of portrait")).toHaveAttribute("aria-pressed", "true")
    await expect(slot("Page 2 of portrait")).toHaveAttribute("aria-pressed", "true")
    await pageControl("Page 1 of portrait", "toggle").click()
    await expect(slot("Page 1 of portrait")).toHaveAttribute("aria-pressed", "false")

    await pageControl("Page 1 of portrait", "delete").click()
    await expect(total()).resolves.toBe("1 page from 1 file")
    await expect(slot("Page 2 of portrait")).toHaveAttribute("aria-pressed", "true")
  })

  it("hands keyboard focus on when a page's own delete takes the page away", async () => {
    await organizeWith([landscape()])
    // Enter or Space on a focused button: a click that counts no presses.
    const pressDelete = (label: string) =>
      browser.execute((selector: string) => {
        const button = document.querySelector<HTMLElement>(selector)!

        button.focus()
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }))
      }, `${workspace} [data-slot-key]:has(button[aria-label='${label}']) [data-page-action='delete']`)
    const focused = () =>
      browser.execute(() => document.activeElement?.getAttribute("aria-label"))

    await pressDelete("Page 2 of landscape")
    await browser.waitUntil(async () => (await total()) === "2 pages from 1 file")
    expect(await focused()).toBe("Page 3 of landscape")

    // The file's last page hands it back to the one before.
    await pressDelete("Page 3 of landscape")
    await browser.waitUntil(async () => (await total()) === "1 page from 1 file")
    expect(await focused()).toBe("Page 1 of landscape")
  })

  it("keeps every page where it stood when a page turns", async () => {
    // Pages of one shape: the turned page is wider than any the board had.
    await organizeWith([portrait()])
    const cells = () =>
      browser.execute(
        (scope: string) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(`${scope} [data-slot-key]`),
            (cell) =>
              `${cell.offsetLeft},${cell.offsetTop} ${cell.offsetWidth}x${cell.offsetHeight}`,
          ),
        workspace,
      )
    const before = await cells()

    await pageControl("Page 1 of portrait", "rotate-right").click()
    await expect(slot("Page 1 of portrait")).toHaveAttribute("data-rotation", "90")
    expect(await cells()).toEqual(before)
  })

  it("inserts a blank page from the gap between two pages", async () => {
    await organizeWith([portrait()])

    await $(`${workspace} button[aria-label='Insert a blank page before page 2']`).click()
    await browser.waitUntil(
      async () =>
        JSON.stringify(await slotLabels("portrait")) ===
        JSON.stringify(["Page 1 of portrait", "Blank page", "Page 2 of portrait"]),
      { timeoutMsg: "no blank page joined the gap" },
    )

    // Only the file's last page has a gap after it.
    await $(`${workspace} button[aria-label='Insert a blank page after page 3']`).click()
    await browser.waitUntil(
      async () => (await slotLabels("portrait")).at(-1) === "Blank page",
      { timeoutMsg: "no blank page joined the file's end" },
    )
    await expect(
      $(`${workspace} button[aria-label='Insert a blank page after page 2']`),
    ).not.toBeExisting()
  })

  it("spins a page the way it turns", async () => {
    await organizeWith([portrait()])
    // A page spins only once its pixels are there to spin.
    await $(`${workspace} [data-slot-key] canvas[data-rendered='true']`).waitForExist({
      timeout: 30_000,
    })
    await browser.execute(() => {
      const spins: string[] = []
      const animate = Element.prototype.animate

      ;(window as Window & { spins?: string[] }).spins = spins
      Element.prototype.animate = function (keyframes, options) {
        const first = Array.isArray(keyframes) ? keyframes[0] : undefined

        if (typeof first?.transform === "string" && first.transform.startsWith("rotate(")) {
          spins.push(first.transform)
        }

        return animate.call(this, keyframes, options)
      }
    })
    const spins = () =>
      browser.execute(() => (window as Window & { spins?: string[] }).spins ?? [])

    await pageControl("Page 1 of portrait", "rotate-left").click()
    await browser.waitUntil(async () => (await spins()).length === 1, {
      timeoutMsg: "the page turned without spinning",
    })
    await pageControl("Page 1 of portrait", "rotate-right").click()
    await browser.waitUntil(async () => (await spins()).length === 2, {
      timeoutMsg: "the page turned back without spinning",
    })
    // Each spin starts from where the page stood: a quarter back the other way.
    expect(await spins()).toEqual(["rotate(90deg)", "rotate(-90deg)"])
  })

  it("previews the bookmarks the new PDF will carry", async () => {
    await organizeWith([writeScratchPdf("outlined.pdf", outlinedPdf()), portrait()])

    await $(`${sidebar} button[aria-label='Bookmarks']`).click()
    const outline = $(`${sidebar} nav[aria-label='Bookmarks']`)
    await expect(outline).toHaveText(expect.stringContaining("outlined"))
    await expect(outline).toHaveText(expect.stringContaining("portrait"))

    await $(`${workspace} [data-slot='organize-bookmarks']`).click()
    await $("[data-action='organize-keep-bookmarks']").click()
    await browser.keys("Escape")
    await expect(outline).toHaveText(expect.stringContaining("Second half"))
  })

  it("starts a file on an odd page with a blank only where it needs one", async () => {
    await organizeWith([writeScratchPdf("one.pdf", minimalPdf(1)), portrait()])
    await expect($(`${workspace} [data-organize-padding]`)).not.toBeExisting()

    await $(`${workspace} [data-slot='organize-smart-padding']`).click()
    // It closes the file before, rather than opening the next one.
    await expect(
      $(`${workspace} section[aria-label='one'] [data-organize-flow] > [data-organize-padding]:last-child`),
    ).toBeDisplayed()
    await expect(total()).resolves.toBe("4 pages from 2 files")
  })

  it("adds the files dropped on it rather than opening them", async () => {
    await organizeWith([portrait()])
    await emitDrag("drag-drop", { x: 600, y: 400 }, [landscape()])

    await browser.waitUntil(async () => (await groupCount()) === 2, {
      timeout: 30_000,
      timeoutMsg: "the dropped file never joined the board",
    })
    expect((await $$("[data-document-tab]").getElements()).length).toBe(0)
  })

  it("asks before a quit discards an arrangement no PDF was made of", async () => {
    await organizeWith([portrait()])
    // A real quit would end the process this spec drives.
    await browser.execute(() => {
      const app = window as Window & { __tfolioE2E?: E2eOverrides }

      app.__tfolioE2E = {
        ...app.__tfolioE2E,
        quitApp: async () => {
          document.documentElement.dataset.quitRequested = "true"
        },
      }
    })

    await clickAppMenuItem("exit")
    const prompt = $("[role='alertdialog']")
    await expect(prompt).toHaveText(
      expect.stringContaining("have not been made into a PDF yet"),
    )
    await prompt.$("button=Keep editing").click()
    await expect(prompt).not.toBeDisplayed()
    expect(
      await browser.execute(() => document.documentElement.dataset.quitRequested),
    ).toBeFalsy()
    expect(await groupCount()).toBe(1)
  })
})
