import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { PdfDocumentInfo } from "../../src/lib/pdf"
import {
  clickAppMenuItem,
  emitDrag,
  minimalPdf,
  outlinedPdf,
  pointMultiPickerAt,
  pointSaveAsAt,
  pressRedo,
  refreshApp,
  seedSettings,
  settingsHold,
  writeScratchPdf,
} from "./helpers"
import { calibratePointer, doubleClickAt } from "./nativePointer"

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

/** Answers the save dialog "Save as PDF" opens first with `destination`, and
    runs the real assembly and write behind it through the command the e2e
    build keeps for this; null cancels the dialog. */
async function pointSaveAt(destination: string | null) {
  await browser.execute((target: string | null) => {
    const seam = window as unknown as Window & {
      __tfolioE2E?: E2eOverrides
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) => Promise<unknown>
      }
    }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      saveAssembledPdf: ({ onProgress, plan }) =>
        target === null
          ? Promise.resolve(null)
          : (seam.__TAURI_INTERNALS__.invoke("save_assembled_pdf_to", {
              onProgress,
              path: target,
              plan,
            }) as Promise<PdfDocumentInfo | null>),
    }
  }, destination)
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

  it("opens on the thumbnail size the reader last chose", async () => {
    const bar = `${workspace} [data-slot='status-bar']`
    const slider = () => $(`${bar} input[aria-label='Thumbnail size']`)
    await organizeWith([portrait()])

    await $(`${bar} button[aria-label='Larger thumbnails']`).click()
    await expect(slider()).toHaveAttribute("aria-valuetext", "3 of 4")
    // A reload before the write lands would read the old size back.
    await settingsHold(["organizeThumbnailSize = 200"])

    await refreshApp()
    await $("button[aria-label='Organize pages']").click()
    await expect(slider()).toHaveAttribute("aria-valuetext", "3 of 4")
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
    const sources = [portrait(), landscape()]
    const destination = path.join(path.dirname(sources[0]!), "combined.pdf")
    await organizeWith(sources)

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

    await pointSaveAt(destination)
    await $(`${workspace} [data-slot='organize-save']`).click()
    await browser.waitUntil(
      async () =>
        (await $("[role='tab'][aria-selected='true']").getText()).includes(
          "combined.pdf",
        ),
      { timeout: 30_000, timeoutMsg: "the assembled PDF never opened as a tab" },
    )
    await expect($(workspace)).not.toBeDisplayed()
    // Saved before it was shown: the tab is the file's, not an unsaved copy.
    expect(existsSync(destination)).toBe(true)
    expect(readFileSync(destination).subarray(0, 5).toString()).toBe("%PDF-")
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

  it("builds nothing when its save dialog is cancelled", async () => {
    await organizeWith([portrait()])
    await pointSaveAt(null)

    const save = $(`${workspace} [data-slot='organize-save']`)
    await save.click()
    await expect(save).toBeEnabled()
    await expect($(workspace)).toBeDisplayed()
    await expect($("[data-testid='organize-progress']")).not.toBeDisplayed()
    expect((await $$("[data-document-tab]").getElements()).length).toBe(0)
  })

  it("previews the PDF unsaved, for a Save As once the reader likes it", async () => {
    const source = portrait()
    const directory = path.dirname(source)
    const destination = path.join(directory, "kept.pdf")
    await organizeWith([source])

    await $(`${workspace} [data-slot='organize-preview']`).click()
    await browser.waitUntil(
      async () =>
        (await $("[role='tab'][aria-selected='true']").getText()).includes(
          "Organized.pdf",
        ),
      { timeout: 30_000, timeoutMsg: "the preview never opened as a tab" },
    )
    await expect($(workspace)).not.toBeDisplayed()
    await expect($("[data-slot='page-status']")).toHaveAttribute(
      "aria-label",
      "Page 1 of 2",
    )
    expect(readdirSync(directory)).toEqual(["portrait.pdf"])

    await pointSaveAsAt(destination)
    await clickAppMenuItem("save-as")
    await browser.waitUntil(
      async () =>
        (await $("[role='tab'][aria-selected='true']").getText()).includes("kept.pdf"),
      { timeout: 15_000, timeoutMsg: "Save As never bound the preview to its file" },
    )
    expect(existsSync(destination)).toBe(true)
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

  it("lists each file with the bookmarks the new PDF will carry, folded or cleared", async () => {
    await organizeWith([writeScratchPdf("outlined.pdf", outlinedPdf()), portrait()])
    const files = $(`${sidebar} [data-slot='organize-files']`)
    await expect(files).toHaveText(expect.stringContaining("Second half"))

    await $(`${sidebar} [data-slot='organize-collapse-all']`).click()
    await expect(files).not.toHaveText(expect.stringContaining("Second half"))
    await expect($(`${sidebar} [data-slot='organize-collapse-all']`)).toBeDisabled()
    await $(`${sidebar} button[aria-label='Show the bookmarks of outlined']`).click()
    await expect(files).toHaveText(expect.stringContaining("Second half"))

    const toggle = $(`${workspace} [data-slot='organize-bookmarks']`)
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await expect(files).not.toHaveText(expect.stringContaining("Second half"))
    await expect($(`${sidebar} [data-slot='organize-no-bookmarks']`)).toBeDisplayed()
    await expect($(`${sidebar} [data-slot='organize-expand-all']`)).toBeDisabled()
  })

  it("edits a file's bookmark text, its heading on the board too", async () => {
    await organizeWith([portrait(), landscape()])
    // Looked up afresh: each edit mounts a field of its own.
    const field = () => $(`${sidebar} [data-slot='organize-file-title']`)
    // Typed in place: a WebDriver clear blurs the field, which settles it.
    const typeTitle = (text: string) =>
      browser.execute(
        (selector: string, value: string) => {
          document.querySelector<HTMLInputElement>(selector)!.value = value
        },
        `${sidebar} [data-slot='organize-file-title']`,
        text,
      )

    await $(`${sidebar} button[aria-label='Edit the bookmark portrait']`).click()
    await expect(field()).toBeFocused()
    await typeTitle("Introduction")
    await browser.keys("Enter")
    await expect(field()).not.toBeExisting()
    await expect($(`${workspace} section[aria-label='Introduction']`)).toBeExisting()

    const offset = await calibratePointer()
    const name = await $(
      `${sidebar} [data-slot='organize-files'] > li:nth-child(2) [data-slot='organize-file-name']`,
    ).getLocation()
    doubleClickAt({ x: name.x + 8 + offset.x, y: name.y + 8 + offset.y })
    await expect(field()).toBeFocused()
    await typeTitle("Elsewhere")
    await browser.keys("Escape")
    await expect(field()).not.toBeExisting()
    await expect($(`${workspace} section[aria-label='landscape']`)).toBeExisting()

    await $(`${workspace} button[aria-label='Undo']`).click()
    await expect($(`${workspace} section[aria-label='portrait']`)).toBeExisting()
  })

  it("reorders files by dragging, every file folded to one row while it moves", async () => {
    await organizeWith([writeScratchPdf("outlined.pdf", outlinedPdf()), portrait()])
    const files = `${sidebar} [data-slot='organize-files']`
    await expect($(files)).toHaveText(expect.stringContaining("Second half"))

    // The list's drag listens on the document, which dispatched events reach.
    await browser.execute((list: string) => {
      const [tall, short] = Array.from(document.querySelectorAll<HTMLElement>(`${list} > li`))
      const name = tall!.querySelector("[data-slot='organize-file-name']")!
      const box = name.getBoundingClientRect()
      const start = { x: box.left + 4, y: box.top + box.height / 2 }

      name.dispatchEvent(
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
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: start.x,
          clientY: short!.getBoundingClientRect().bottom - 2,
        }),
      )
    }, files)

    // Folded, the other file makes way by the dragged one's row alone.
    await browser.waitUntil(
      () =>
        browser.execute((list: string) => {
          const [tall, short] = Array.from(document.querySelectorAll<HTMLElement>(`${list} > li`))
          const shift = Number(/-?[\d.]+/.exec(short!.style.transform)?.[0] ?? 0)

          return (
            !document.querySelector(`${list} [data-organize-outline]`) &&
            Math.abs(shift - (tall!.offsetTop - short!.offsetTop)) < 0.5 &&
            tall!.offsetHeight < 40
          )
        }, files),
      { timeoutMsg: "the files never folded and made way for the dragged one" },
    )
    // Below the other file as it stands folded, whatever it has slid to.
    await browser.execute((list: string) => {
      const [tall, short] = Array.from(document.querySelectorAll<HTMLElement>(`${list} > li`))
      const box = tall!.getBoundingClientRect()
      const y = box.top + short!.offsetTop - tall!.offsetTop + short!.offsetHeight - 2

      document.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: box.left + 8, clientY: y }),
      )
    }, files)

    await browser.waitUntil(
      async () =>
        JSON.stringify(
          await browser.execute((scope: string) =>
            Array.from(document.querySelectorAll(`${scope} section[data-group-id]`), (section) =>
              section.getAttribute("aria-label"),
            ),
            workspace,
          ),
        ) === JSON.stringify(["portrait", "outlined"]),
      { timeout: 10_000, timeoutMsg: "the dragged file never moved after the other" },
    )
    await expect($(files)).toHaveText(expect.stringContaining("Second half"))
  })

  it("keeps a file it barely moved in place, though the files above it fold", async () => {
    await organizeWith([
      writeScratchPdf("first.pdf", outlinedPdf()),
      writeScratchPdf("second.pdf", outlinedPdf()),
      portrait(),
      landscape(),
    ])
    const files = `${sidebar} [data-slot='organize-files']`
    await expect($(files)).toHaveText(expect.stringContaining("Second half"))

    // Past the drag threshold and no further, on the third of four files.
    const pressedAt = await browser.execute((list: string) => {
      const name = document.querySelector(`${list} > li:nth-child(3) [data-slot='organize-file-name']`)!
      const box = name.getBoundingClientRect()
      const x = box.left + 4
      const y = box.top + box.height / 2

      name.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y, isPrimary: true }),
      )
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: y + 6 }))

      return { top: box.top, x, y: y + 6 }
    }, files)

    // The bookmarks above fold away, and the pressed file stays under the pointer.
    await browser.waitUntil(
      () =>
        browser.execute(
          (list: string, top: number) =>
            !document.querySelector(`${list} [data-organize-outline]`) &&
            Math.abs(
              document
                .querySelector(`${list} > li:nth-child(3) [data-slot='organize-file-name']`)!
                .getBoundingClientRect().top - top,
            ) < 1,
          files,
          pressedAt.top,
        ),
      { timeoutMsg: "the pressed file did not stay where it was pressed" },
    )
    await browser.execute((point: { x: number; y: number }) => {
      document.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: point.x, clientY: point.y }),
      )
    }, pressedAt)

    await expect($(files)).toHaveText(expect.stringContaining("Second half"))
    expect(
      await browser.execute((scope: string) =>
        Array.from(document.querySelectorAll(`${scope} section[data-group-id]`), (section) =>
          section.getAttribute("aria-label"),
        ),
        workspace,
      ),
    ).toEqual(["first", "second", "portrait", "landscape"])
    // The list gives back the room it took to hold the file there.
    expect(
      await browser.execute((list: string) => document.querySelector<HTMLElement>(list)!.style.cssText, files),
    ).toBe("")
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
