import { writeFileSync } from "node:fs"
import path from "node:path"
import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import {
  activeSidebar,
  clickAppMenuItem,
  contextMenuAction,
  emitDrag,
  minimalPdf,
  openPdfFromDisk,
  outlinedPdf,
  pointMultiPickerAt,
  pointSaveAsAt,
  refreshApp,
  seedSettings,
  sidebarPageAction,
  signedPdf,
  writeScratchPdf,
} from "./helpers"

const saveTrigger = `[data-document-session][data-active='true'] [data-slot='pdf-save-trigger']`

const session = "[data-document-session][data-active='true']"

/** The sidebar's body while no document is open. */
const homeSidebar = "[data-slot='home-sidebar']"

function sidebarMiddle(scope: string) {
  return browser.execute((within: string) => {
    const box = document.querySelector(within)!.getBoundingClientRect()

    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  }, scope)
}

function pageCount() {
  return browser.execute(
    (within: string) => document.querySelectorAll(`${within} button[data-thumbnail-page]`).length,
    activeSidebar,
  )
}

async function waitForPages(count: number) {
  await browser.waitUntil(async () => (await pageCount()) === count, {
    timeout: 30_000,
    timeoutMsg: `the document never held ${count} pages`,
  })
}

const fileName = (section: number) =>
  `${activeSidebar} [data-section-header='${section}'] [data-slot='pages-file-heading']`

/** The file names heading the pages, top to bottom. */
function headings() {
  return browser.execute(
    (within: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`${within} [data-slot='pages-file-heading']`),
        (heading) => heading.textContent ?? "",
      ),
    activeSidebar,
  )
}

/** Each page's file, by the heading above it. */
function pageFiles() {
  return browser.execute((scope: string) => {
    let file = ""

    return Array.from(
      document.querySelectorAll<HTMLElement>(
        `${scope} [data-section-header], ${scope} button[data-thumbnail-page]`,
      ),
      (element) => {
        if (element.dataset.sectionHeader !== undefined) {
          file = element.querySelector("[data-slot='pages-file-heading']")?.textContent ?? ""
          return null
        }

        return file
      },
    ).filter((name) => name !== null)
  }, activeSidebar)
}

/** Pressed the way the keyboard would: the controls show under a real pointer. */
function press(selector: string) {
  return browser.execute((target: string) => {
    const control = document.querySelector<HTMLElement>(target)!

    control.focus()
    control.click()
  }, selector)
}

/** A reader's drag from one element to the top of another, its press and
    first move apart from the rest so the list lays out its drag between. */
async function dragOnto(from: string, to: string, at: "top" | "left") {
  await browser.execute((source: string) => {
    const element = document.querySelector(source)!
    const box = element.getBoundingClientRect()
    const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 }

    element.dispatchEvent(
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
        clientX: start.x,
        clientY: start.y + 12,
        isPrimary: true,
      }),
    )
  }, from)
  await browser.pause(200)
  await browser.execute(
    (target: string, edge: string) => {
      const box = document.querySelector(target)!.getBoundingClientRect()
      const point =
        edge === "top"
          ? { x: box.left + box.width / 2, y: box.top + 3 }
          : { x: box.left + 6, y: box.top + box.height / 2 }

      for (const type of ["pointermove", "pointerup"]) {
        document.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            clientX: point.x,
            clientY: point.y,
            isPrimary: true,
          }),
        )
      }
    },
    to,
    at,
  )
}

function chosen() {
  return browser.execute(
    (within: string) =>
      Array.from(
        document.querySelectorAll(`${within} button[data-thumbnail-page][aria-pressed='true']`),
        (button) => Number(button.getAttribute("data-thumbnail-page")),
      ).sort((left, right) => left - right),
    activeSidebar,
  )
}

/** Folds every file to its name, or shows their pages again, by the
    buttons over the pages: the one pressed has nothing left to do. */
async function foldAllFiles(folded: boolean) {
  const button = $(`${activeSidebar} [data-slot='sidebar-${folded ? "fold" : "unfold"}-all']`)

  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toBeDisabled()
}

async function addFilesFromPicker(paths: string[]) {
  await pointMultiPickerAt(paths)
  await $(`${activeSidebar} [data-slot='sidebar-add-files']`).click()
}

/** Ticks or unticks one of the files' options, in the menu over the pages. */
async function toggleFileOption(option: "file-rows" | "smart-padding" | "file-bookmarks") {
  await $(`${activeSidebar} [data-slot='pages-file-options']`).click()

  const item = $(`[data-action='${option}']`)

  await item.waitForDisplayed({ timeout: 5_000 })
  await item.click()
  // A tick leaves the menu open for the next one.
  await browser.keys("Escape")
  await item.waitForDisplayed({ reverse: true, timeout: 5_000 })
}

/** The names down the sidebar's tree of files, one per run of a file's pages. */
function treeFiles() {
  return browser.execute(
    (scope: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `${scope} [data-slot='file-section-title'] span.truncate`,
        ),
        (name) => name.textContent ?? "",
      ),
    activeSidebar,
  )
}

describe("TFolio files added to an open document", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  it("adds files at the end as files of their own, one undo away", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await waitForPages(2)
    expect(await headings()).toEqual([])

    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(1)),
      writeScratchPdf("second.pdf", outlinedPdf()),
    ])
    await waitForPages(5)

    expect(await headings()).toEqual(["own.pdf", "first.pdf", "second.pdf"])
    expect(await pageFiles()).toEqual([
      "own.pdf",
      "own.pdf",
      "first.pdf",
      "second.pdf",
      "second.pdf",
    ])
    // Saved only as a new file: the save button is Save As itself.
    await expect($(saveTrigger)).toHaveAttribute("data-save-as-only", "")
    await expect($(saveTrigger)).toBeEnabled()

    // The files, and each one's bookmarks, where the bookmarks would be.
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    const files = $(`${activeSidebar} [data-slot='file-sections']`)
    await expect(files).toHaveText(expect.stringContaining("second.pdf"))
    await expect(files).toHaveText(expect.stringContaining("Second half"))
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()

    await browser.keys(["Control", "z"])
    await waitForPages(2)
    expect(await headings()).toEqual([])
    await expect($(saveTrigger)).not.toHaveAttribute("data-save-as-only")
  })

  it("says a file changed on disk since it was read, so it must be added again", async () => {
    const signed = writeScratchPdf("signed.pdf", signedPdf())
    const prompt = "[data-slot='signature-prompt']"

    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await waitForPages(1)
    await pointMultiPickerAt([signed])
    await $(`${activeSidebar} [data-slot='sidebar-add-files']`).click()

    // The signature question holds the file between its read and its add:
    // meanwhile it leaves memory, as the parsed budget would let it go, and
    // changes on disk, so the add reads another file than the one shown.
    await $(prompt).waitForDisplayed()
    await browser.execute(() =>
      (
        window as unknown as Window & {
          __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke("unload_pdf_sources"),
    )
    writeFileSync(signed, minimalPdf(3))
    await $(`${prompt} [data-action='signatures-flatten']`).click()

    await $("[data-notice='filesChanged']").waitForDisplayed({ timeout: 15_000 })
    expect(await pageCount()).toBe(1)
  })

  it("runs the files together when the reader turns their rows off", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(1))])
    await waitForPages(2)
    expect(await headings()).toEqual(["own.pdf", "added.pdf"])

    await toggleFileOption("file-rows")
    await browser.waitUntil(async () => (await headings()).length === 0)
  })

  it("adds files from under the sidebar, whichever panel shows, and from the app's menu", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await waitForPages(1)
    const tree = (names: string) =>
      browser.waitUntil(async () => (await treeFiles()).join() === names, {
        timeout: 30_000,
        timeoutMsg: `the tree never listed ${names}`,
      })

    // In a row of its own, level with the status bar beside it.
    const offsets = await browser.execute((scope: string) => {
      const row = document.querySelector(`${scope} [data-slot='sidebar-footer']`)!
      const bar = document.querySelector(
        "[data-document-session][data-active='true'] [data-slot='status-bar']",
      )!
      const [rowBox, barBox] = [row, bar].map((element) => element.getBoundingClientRect())

      return [rowBox.top - barBox.top, rowBox.bottom - barBox.bottom]
    }, activeSidebar)
    expect(offsets).toEqual([0, 0])

    // A document of one file has its bookmarks there, and the same way in.
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    await expect($(`${activeSidebar} nav[aria-label='Bookmarks']`)).toBeDisplayed()
    await pointMultiPickerAt([writeScratchPdf("bookmarks.pdf", minimalPdf(1))])
    await $(`${activeSidebar} [data-slot='sidebar-add-files']`).click()
    await tree("own.pdf,bookmarks.pdf")

    await pointMultiPickerAt([writeScratchPdf("menu.pdf", minimalPdf(1))])
    await clickAppMenuItem("add-files")
    await tree("own.pdf,bookmarks.pdf,menu.pdf")

    await pointMultiPickerAt([writeScratchPdf("tree.pdf", minimalPdf(1))])
    await $(`${activeSidebar} [data-slot='sidebar-add-files']`).click()
    await tree("own.pdf,bookmarks.pdf,menu.pdf,tree.pdf")
  })

  it("adds files dropped below the sidebar's pages at the end", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await waitForPages(2)
    const point = await browser.execute((scope: string) => {
      const box = document.querySelector(`${scope} [data-pages-surface]`)!.getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.bottom - 24 }
    }, activeSidebar)
    const dropped = writeScratchPdf("dropped.pdf", minimalPdf(3, "0 0 300 200"))

    await emitDrag("drag-over", point, [dropped])
    await expect($(`${activeSidebar} [data-testid='sidebar-drop']`)).toHaveAttribute(
      "data-over",
      "",
    )
    await emitDrag("drag-drop", point, [dropped])
    await waitForPages(5)
    expect(await headings()).toEqual(["own.pdf", "dropped.pdf"])
    // Added to this document, not opened beside it.
    expect((await $$("[data-document-tab]").getElements()).length).toBe(1)
  })

  it("adds files dropped between two pages there", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await waitForPages(2)
    // Over the second page's top edge: the gap in front of it.
    const point = await browser.execute((scope: string) => {
      const box = document
        .querySelector(`${scope} button[data-thumbnail-page='2']`)!
        .getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.top + 8 }
    }, activeSidebar)
    const dropped = writeScratchPdf("between.pdf", minimalPdf(3, "0 0 300 200"))

    await emitDrag("drag-over", point, [dropped])
    await expect($("[data-testid='pages-drop-marker']")).toBeDisplayed()
    // What the drop does is said in the bar over the pages, where it covers
    // none of them, in place of the bar's own controls.
    await expect($(`${activeSidebar} [data-slot='sidebar-drop-hint']`)).toHaveText(
      "Drop to add to this document",
    )
    await expect($(`${activeSidebar} [data-slot='sidebar-fold-all']`)).not.toBeDisplayed()
    await emitDrag("drag-drop", point, [dropped])
    await waitForPages(5)
    await expect($(`${activeSidebar} [data-slot='sidebar-fold-all']`)).toBeDisplayed()
    expect(await headings()).toEqual(["own.pdf", "between.pdf", "own.pdf"])
    // The tree lists the parted file as the pages head it, and a Save As writes it.
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    expect(await treeFiles()).toEqual(["own.pdf", "between.pdf", "own.pdf"])
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()

    await browser.keys(["Control", "z"])
    await waitForPages(2)
  })

  it("shows the blanks dropped files would bring before they land", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(3))
    await waitForPages(3)
    const blankAfter = (page: number) => $(`${activeSidebar} [data-padding-after='${page}']`)
    const dropped = writeScratchPdf("dropped.pdf", minimalPdf(2))
    const beforeSecond = await browser.execute((scope: string) => {
      const box = document
        .querySelector(`${scope} button[data-thumbnail-page='2']`)!
        .getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.top + 8 }
    }, activeSidebar)
    const belowPages = await browser.execute((scope: string) => {
      const box = document
        .querySelector(`${scope} [data-slot='sidebar-thumbnails']`)!
        .getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.bottom - 60 }
    }, activeSidebar)

    // In front of page 2, the one page before them leaves the files on page 2.
    await emitDrag("drag-over", beforeSecond, [dropped])
    await expect(blankAfter(1)).toBeDisplayed()
    await expect(blankAfter(3)).not.toBeExisting()
    // After three pages, a blank backs the third.
    await emitDrag("drag-over", belowPages, [dropped])
    await expect(blankAfter(3)).toBeDisplayed()
    await expect(blankAfter(1)).not.toBeExisting()
    await emitDrag("drag-leave", belowPages, [])
    await expect(blankAfter(3)).not.toBeExisting()

    // The add lays them out as shown.
    await emitDrag("drag-over", belowPages, [dropped])
    await emitDrag("drag-drop", belowPages, [dropped])
    await waitForPages(5)
    await expect(blankAfter(3)).toBeDisplayed()
  })

  it("scrolls the pages on while files are held near their edge", async () => {
    await openPdfFromDisk("long.pdf", minimalPdf(30))
    await waitForPages(30)
    const pagesView = `${activeSidebar} [data-slot='sidebar-thumbnails']`
    const nearBottom = await browser.execute((view: string) => {
      const box = document.querySelector(view)!.getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.bottom - 10 }
    }, pagesView)

    // One report and held still: the OS sends no more while nothing moves.
    await emitDrag("drag-over", nearBottom, [writeScratchPdf("held.pdf", minimalPdf(1))])
    await browser.waitUntil(
      async () =>
        (await browser.execute((view: string) => document.querySelector(view)!.scrollTop, pagesView)) >
        200,
      { timeout: 10_000, timeoutMsg: "the pages never scrolled under the held files" },
    )
    await emitDrag("drag-leave", nearBottom, [])
  })

  it("adds files dropped on the outline at the end, as its bar says", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await waitForPages(2)
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    await $(`${activeSidebar} [data-slot='outline-bar']`).waitForDisplayed()
    const point = await sidebarMiddle(activeSidebar)
    const dropped = writeScratchPdf("outlined.pdf", minimalPdf(3, "0 0 300 200"))

    await emitDrag("drag-over", point, [dropped])
    await expect($(`${activeSidebar} [data-testid='sidebar-drop']`)).toHaveAttribute(
      "data-over",
      "",
    )
    await expect($(`${activeSidebar} [data-slot='sidebar-drop-hint']`)).toHaveText(
      "Drop to add at the end of this document",
    )
    await emitDrag("drag-drop", point, [dropped])
    await browser.waitUntil(async () => (await treeFiles()).join() === "own.pdf,outlined.pdf", {
      timeout: 30_000,
      timeoutMsg: "the tree never listed the dropped file after the document's own",
    })
    expect((await $$("[data-document-tab]").getElements()).length).toBe(1)
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()
    await waitForPages(5)
  })

  it("adds files dropped between two files of the outline there", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await addFilesFromPicker([writeScratchPdf("last.pdf", minimalPdf(1))])
    await waitForPages(3)
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    await browser.waitUntil(async () => (await treeFiles()).join() === "own.pdf,last.pdf", {
      timeout: 30_000,
      timeoutMsg: "the tree never listed both files",
    })
    // Over the top of the second file's row: the gap in front of it.
    const point = await browser.execute((scope: string) => {
      const box = document
        .querySelectorAll(`${scope} [data-slot='file-section-row']`)[1]!
        .getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.top + 3 }
    }, activeSidebar)
    const dropped = writeScratchPdf("middle.pdf", minimalPdf(2))

    await emitDrag("drag-over", point, [dropped])
    await expect($(`${activeSidebar} [data-testid='files-drop-marker']`)).toBeDisplayed()
    await expect($(`${activeSidebar} [data-slot='sidebar-drop-hint']`)).toHaveText(
      "Drop to add to this document",
    )
    await emitDrag("drag-drop", point, [dropped])
    await browser.waitUntil(
      async () => (await treeFiles()).join() === "own.pdf,middle.pdf,last.pdf",
      { timeout: 30_000, timeoutMsg: "the dropped file never landed between the two" },
    )
  })

  it("merges files dropped on the home tab's sidebar into a new PDF", async () => {
    const point = await sidebarMiddle(homeSidebar)
    const files = [
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(3, "0 0 300 200")),
    ]

    await emitDrag("drag-enter", point, files)
    await expect($(`${homeSidebar} [data-testid='sidebar-drop']`)).toHaveAttribute(
      "data-over",
      "",
    )
    await expect($(`${homeSidebar} [data-slot='sidebar-drop-hint']`)).toHaveText(
      "Drop to combine into a new PDF",
    )
    await emitDrag("drag-drop", point, files)
    await waitForPages(5)
    expect(await headings()).toEqual(["first.pdf", "second.pdf"])

    // One new document, named as a new one is, with unsaved work to save.
    const tabs = await browser.execute(() =>
      Array.from(document.querySelectorAll("[data-document-tab]"), (tab) => tab.textContent ?? ""),
    )
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toContain("Untitled.pdf")
    await expect($(saveTrigger)).toBeEnabled()
  })

  it("opens one file dropped on the home tab's sidebar, as anywhere else", async () => {
    const point = await sidebarMiddle(homeSidebar)
    const only = writeScratchPdf("only.pdf", minimalPdf(2))

    await emitDrag("drag-enter", point, [only])
    // No target of its own: the window's covers the sidebar too.
    await $("[data-testid='workspace-file-drop']").waitForDisplayed()
    await expect($("[data-testid='sidebar-drop']")).not.toBeExisting()
    const covers = await browser.execute(
      (scope: string) =>
        document.querySelector("[data-testid='workspace-file-drop']")!.getBoundingClientRect()
          .left < document.querySelector(scope)!.getBoundingClientRect().right,
      homeSidebar,
    )
    expect(covers).toBe(true)

    await emitDrag("drag-drop", point, [only])
    await waitForPages(2)
    expect(await headings()).toEqual([])
    expect((await $$("[data-document-tab]").getElements()).length).toBe(1)
  })

  it("names the dropped files no flow can take, adding the rest", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await waitForPages(2)
    const point = await browser.execute((scope: string) => {
      const box = document.querySelector(`${scope} [data-pages-surface]`)!.getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.bottom - 24 }
    }, activeSidebar)
    const taken = writeScratchPdf("taken.pdf", minimalPdf(1))
    const notes = writeScratchPdf("notes.txt", new Uint8Array(Buffer.from("notes", "utf8")))

    await emitDrag("drag-drop", point, [taken, notes])
    await expect($("[data-notice='filesSkipped']")).toHaveText(
      "Skipped notes.txt, which is not a PDF, image, or Word document.",
    )
    await waitForPages(3)
    expect(await headings()).toEqual(["own.pdf", "taken.pdf"])
  })

  it("renames a file and removes one, each undoably", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)
    await $(`${activeSidebar} button[aria-label='Outline']`).click()

    // A row ends on its page count, at its right edge; its two buttons stand
    // in the count's place, never over the name, and take it only while the
    // pointer or the keyboard is on them.
    const rowEnd = () =>
      browser.execute((scope: string) => {
        const part = (slot: string) =>
          document.querySelector(`${scope} [data-section-id='1'] [data-slot='${slot}']`)!
        const [line, count, tools] = ["row", "count", "tools"].map((slot) =>
          part(`file-section-${slot}`).getBoundingClientRect(),
        )

        return {
          count: getComputedStyle(part("file-section-count")).opacity,
          countFromEdge: Math.round(line!.right - count!.right),
          tools: getComputedStyle(part("file-section-tools")).opacity,
          toolsInCountsPlace: tools!.right === count!.right && tools!.left >= count!.left,
        }
      }, activeSidebar)
    expect(await rowEnd()).toEqual({
      count: "1",
      countFromEdge: 4,
      tools: "0",
      toolsInCountsPlace: true,
    })

    // Tabbed to, as the keyboard reaches them: out to the name and back.
    await browser.execute((scope: string) => {
      document
        .querySelector<HTMLElement>(
          `${scope} [data-section-id='1'] [data-slot='file-section-rename']`,
        )!
        .focus()
    }, activeSidebar)
    await browser.keys(["Shift", "Tab"])
    await browser.keys("Tab")
    await browser.waitUntil(async () => (await rowEnd()).tools === "1", {
      timeoutMsg: "the keyboard's focus never showed the row's buttons",
    })
    expect((await rowEnd()).count).toBe("0")

    await press(`${activeSidebar} [data-section-id='1'] [data-slot='file-section-rename']`)
    const input = $(`${activeSidebar} [data-slot='file-section-title-input']`)
    await input.setValue("Appendix")
    await browser.keys("Enter")
    await expect($(`${activeSidebar} [data-section-id='1']`)).toHaveText(
      expect.stringContaining("Appendix"),
    )

    await press(`${activeSidebar} [data-section-id='1'] [data-slot='file-section-remove']`)
    await expect($(`${activeSidebar} [data-section-id='1']`)).not.toBeExisting()
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()
    await waitForPages(2)

    await browser.keys(["Control", "z"])
    await waitForPages(4)
    await browser.keys(["Control", "z"])
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    await expect($(`${activeSidebar} [data-section-id='1']`)).toHaveText(
      expect.stringContaining("first.pdf"),
    )
  })

  it("renames, chooses and removes a file from its name's menu", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("first.pdf", minimalPdf(2))])
    await waitForPages(3)

    // A page chosen, to prove the name's keys are the name's: Backspace
    // among the pages deletes what is chosen.
    await $(`${activeSidebar} button[data-thumbnail-page='1']`).click()
    await contextMenuAction(fileName(1), "rename-file")
    const input = $(`${activeSidebar} [data-slot='file-section-title-input']`)
    await input.waitForDisplayed()
    await expect(input).toBeFocused()
    await browser.keys("Backspace")
    await input.setValue("Appendix")
    await browser.keys("Enter")
    await browser.waitUntil(async () => (await headings()).join() === "own.pdf,Appendix", {
      timeoutMsg: "the heading never took the typed name",
    })
    expect(await pageCount()).toBe(3)

    await contextMenuAction(fileName(1), "select-file")
    expect(await chosen()).toEqual([2, 3])

    // The tree of files renames in place from its own menu too.
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    await contextMenuAction(
      `${activeSidebar} [data-section-id='1'] [data-slot='file-section-row']`,
      "rename-file",
    )
    const treeInput = $(`${activeSidebar} [data-slot='file-section-title-input']`)
    await treeInput.waitForDisplayed()
    await expect(treeInput).toBeFocused()
    await browser.keys("Escape")
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()

    await contextMenuAction(fileName(1), "remove-file")
    await waitForPages(1)
    await browser.keys(["Control", "z"])
    await waitForPages(3)
  })

  it("chooses a file's pages by its name, and carries them whole by it", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)

    // A name pressed chooses the file's pages and goes to the first of them.
    await $(fileName(1)).click()
    expect(await chosen()).toEqual([2, 3])
    await browser.waitUntil(
      async () =>
        (await $(`${session} [data-slot='page-status']`).getAttribute("aria-label")) ===
        "Page 2 of 4",
      { timeoutMsg: "the name never went to its file's first page" },
    )

    await dragOnto(fileName(2), `${activeSidebar} button[data-thumbnail-page='1']`, "top")
    await browser.waitUntil(
      async () => (await headings()).join() === "second.pdf,own.pdf,first.pdf",
      { timeout: 15_000, timeoutMsg: "the file never moved whole to the front" },
    )

    await browser.keys(["Control", "z"])
    await browser.waitUntil(
      async () => (await headings()).join() === "own.pdf,first.pdf,second.pdf",
    )
  })

  it("folds files to their names, and carries a folded file whole by its name", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)

    // A page chosen and then folded away is let go: a Delete would take it
    // with nothing on screen to say so.
    await $(`${activeSidebar} button[data-thumbnail-page='2']`).click()
    expect(await chosen()).toEqual([2])
    await press(`${activeSidebar} [data-section-header='1'] [data-fold-toggle]`)
    await waitForPages(2)
    await press(`${activeSidebar} [data-section-header='1'] [data-fold-toggle]`)
    await waitForPages(4)
    expect(await chosen()).toEqual([])

    // One file's pages go under its name, which says how many it holds.
    await press(`${activeSidebar} [data-section-header='1'] [data-fold-toggle]`)
    await waitForPages(2)
    await expect(
      $(`${activeSidebar} [data-section-header='1'] [data-slot='pages-file-count']`),
    ).toHaveText("2 pages")
    // Its name still chooses them, though none shows.
    await $(fileName(1)).click()
    await expect($(fileName(1))).toHaveAttribute("aria-pressed", "true")
    await browser.keys("Escape")

    await foldAllFiles(true)
    await waitForPages(0)
    expect(await headings()).toEqual(["own.pdf", "first.pdf", "second.pdf"])

    // Folded, the files are a list to put in order.
    await dragOnto(fileName(2), `${activeSidebar} [data-section-header='0']`, "top")
    await browser.waitUntil(
      async () => (await headings()).join() === "second.pdf,own.pdf,first.pdf",
      { timeout: 15_000, timeoutMsg: "the folded file never moved to the front" },
    )

    await foldAllFiles(false)
    await waitForPages(4)
    expect(await pageFiles()).toEqual(["second.pdf", "own.pdf", "first.pdf", "first.pdf"])

    await browser.keys(["Control", "z"])
    await browser.waitUntil(
      async () => (await headings()).join() === "own.pdf,first.pdf,second.pdf",
      { timeout: 15_000, timeoutMsg: "undo never put the file back" },
    )
  })

  it("moves a file whole by dragging its name in the sidebar's tree", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)
    await $(`${activeSidebar} button[aria-label='Outline']`).click()

    await dragOnto(
      `${activeSidebar} [data-section-id='2'] [data-slot='file-section-title']`,
      `${activeSidebar} [data-section-id='0']`,
      "top",
    )
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()
    await browser.waitUntil(
      async () => (await headings()).join() === "second.pdf,own.pdf,first.pdf",
      { timeout: 15_000, timeoutMsg: "the tree's file never moved to the front" },
    )
  })

  it("pastes a cut page in place before the next file's pages into that file", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(1))])
    await waitForPages(3)
    expect(await pageFiles()).toEqual(["own.pdf", "own.pdf", "added.pdf"])

    await sidebarPageAction(2, "cut-pages")
    await sidebarPageAction(3, "paste-pages-before")
    await browser.waitUntil(
      async () => (await pageFiles()).join() === "own.pdf,added.pdf,added.pdf",
      { timeout: 15_000, timeoutMsg: "the pasted page never joined the next file" },
    )
  })

  it("pastes cut pages at either end of a file, from its name", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(4)

    // From the name heading the file's pages: after its last page, its own.
    await sidebarPageAction(1, "cut-pages")
    await contextMenuAction(fileName(1), "paste-file-end")
    await browser.waitUntil(
      async () => (await pageFiles()).join() === "own.pdf,added.pdf,added.pdf,added.pdf",
      { timeout: 15_000, timeoutMsg: "the pasted page never closed the added file" },
    )

    // From the name in the files' tree: before the file's first page.
    await sidebarPageAction(4, "cut-pages")
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    await contextMenuAction(
      `${activeSidebar} [data-section-id='0'] [data-slot='file-section-row']`,
      "paste-file-start",
    )
    await $(`${activeSidebar} button[aria-label='Thumbnails']`).click()
    await browser.waitUntil(
      async () => (await pageFiles()).join() === "own.pdf,own.pdf,added.pdf,added.pdf",
      { timeout: 15_000, timeoutMsg: "the pasted page never opened the document's own file" },
    )
  })

  it("shows the bookmarks of the one file left", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", outlinedPdf())])
    await waitForPages(3)
    await $(`${activeSidebar} button[aria-label='Outline']`).click()

    await press(`${activeSidebar} [data-section-id='0'] [data-slot='file-section-remove']`)
    await expect($(`${activeSidebar} [data-section-id='0']`)).not.toBeExisting()
    await expect($(`${activeSidebar} nav[aria-label='Bookmarks']`)).toHaveText(
      expect.stringContaining("Second half"),
    )
  })

  it("saves a document with added files only to a new file, which the tab then shows", async () => {
    const own = await openPdfFromDisk("own.pdf", outlinedPdf())
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(1))])
    await waitForPages(3)

    // Beside the opened file, whose scratch folder goes at exit.
    const destination = path.join(path.dirname(own), "combined.pdf")
    await pointSaveAsAt(destination)
    await $(saveTrigger).click()

    // The tab is the new file now, read back as a reopen would: one file,
    // whose bookmarks name the parts it was put together from.
    await browser.waitUntil(
      async () =>
        (await $$(`//button[@role='tab'][normalize-space()='combined.pdf']`).length) === 1,
      { timeout: 30_000, timeoutMsg: "the tab never became the saved file" },
    )
    // The old tab takes the file's name before the file is read back: its
    // headings going is what says the reopened file shows.
    await browser.waitUntil(async () => (await headings()).length === 0, {
      timeout: 30_000,
      timeoutMsg: "the tab never showed the saved file as one file",
    })
    await waitForPages(3)
    await expect($(saveTrigger)).not.toHaveAttribute("data-save-as-only")
    await $(`${activeSidebar} button[aria-label='Outline']`).click()
    const bookmarks = $(`${activeSidebar} nav[aria-label='Bookmarks']`)
    await expect(bookmarks).toHaveText(expect.stringContaining("own.pdf"))
    await expect(bookmarks).toHaveText(expect.stringContaining("added.pdf"))
    await expect(bookmarks).toHaveText(expect.stringContaining("Second half"))
    expect(own.endsWith("own.pdf")).toBe(true)
  })
})

const viewer = "[data-document-session][data-active='true'] [data-pdf-viewer-layout]"

function blanksIn(scope: string) {
  return browser.execute(
    (selector: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`${selector} [data-padding-after]`),
        (blank) => Number(blank.dataset.paddingAfter),
      ),
    scope,
  )
}

/** Presses page `from` of `scope` and holds it over page `over`, past its
    middle, without letting go: `letGoOfPage` releases it there. */
function holdPageAfter(scope: string, from: number, over: number) {
  return browser.execute(
    (fromSelector: string, overSelector: string) => {
      const source = document.querySelector(fromSelector)!
      const fromBox = source.getBoundingClientRect()
      const overBox = document.querySelector(overSelector)!.getBoundingClientRect()
      const start = { x: fromBox.left + fromBox.width / 2, y: fromBox.top + fromBox.height / 2 }
      const held = { x: overBox.left + overBox.width * 0.8, y: overBox.top + overBox.height * 0.8 }

      ;(window as unknown as Window & { __heldAt?: typeof held }).__heldAt = held
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
        new PointerEvent("pointermove", { bubbles: true, clientX: held.x, clientY: held.y }),
      )
    },
    `${scope} button[data-thumbnail-page='${from}']`,
    `${scope} button[data-thumbnail-page='${over}']`,
  )
}

function letGoOfPage() {
  return browser.execute(() => {
    const held = (window as unknown as Window & { __heldAt: { x: number; y: number } }).__heldAt

    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: held.x, clientY: held.y }),
    )
  })
}

describe("TFolio blank pages between files", () => {
  beforeEach(async () => {
    await seedSettings({
      organize: { bookmarks: true, smartPadding: true },
      ui: { language: "en", viewMode: "single" },
    })
    await refreshApp()
  })

  it("lays the blanks out where pages in hand would leave them, and lets go there", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(4)
    expect(await blanksIn(activeSidebar)).toEqual([])

    // The document's first page held past the added file's last: its own
    // file would be left one page, which a blank then backs.
    await holdPageAfter(activeSidebar, 1, 4)
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).join() === "2", {
      timeoutMsg: "the held page never showed the blank its drop would add",
    })

    await letGoOfPage()
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).join() === "1", {
      timeout: 15_000,
      timeoutMsg: "the drop never laid the blank out after the one page left",
    })
    await browser.waitUntil(
      async () => (await pageFiles()).join() === "own.pdf,added.pdf,added.pdf,added.pdf",
      { timeoutMsg: "the held page never joined the added file at its end" },
    )
  })

  it("shows the blank a Save As adds, in the sidebar and the pages, until turned off", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(3)

    // One page, so the next file would start on page 2: a blank closes it.
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).join() === "1")
    expect(await blanksIn(viewer)).toEqual([1])

    await toggleFileOption("smart-padding")
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).length === 0)
    expect(await blanksIn(viewer)).toEqual([])

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).join() === "1")
  })

  it("saves without blanks from a blank itself, among the pages or the previews", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(3)
    await browser.waitUntil(async () => (await blanksIn(viewer)).join() === "1")

    await $(`${viewer} [data-slot='padding-dismiss']`).click()
    await browser.waitUntil(async () => (await blanksIn(viewer)).length === 0)
    expect(await blanksIn(activeSidebar)).toEqual([])

    await browser.keys(["Control", "z"])
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).join() === "1")
    await $(`${activeSidebar} [data-slot='padding-dismiss']`).click()
    await browser.waitUntil(async () => (await blanksIn(activeSidebar)).length === 0)
    expect(await blanksIn(viewer)).toEqual([])
  })

  it("holds the reader's place within a page as the blanks before it come and go", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(3)
    await browser.waitUntil(async () => (await blanksIn(viewer)).join() === "1")

    // Page 2's top against the viewer's: below zero once read halfway down.
    const place = () =>
      browser.execute((scope: string) => {
        const scroll = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
        const page = scroll.querySelector("[data-page-number='2']")!.getBoundingClientRect()

        return Math.round(page.top - scroll.getBoundingClientRect().top)
      }, session)

    await browser.execute((scope: string) => {
      const scroll = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
      const page = scroll.querySelector("[data-page-number='2']")!.getBoundingClientRect()

      scroll.scrollTop += page.top - scroll.getBoundingClientRect().top + page.height / 2
    }, session)
    await browser.pause(300)
    const before = await place()
    expect(before).toBeLessThan(0)

    await toggleFileOption("smart-padding")
    await browser.waitUntil(async () => (await blanksIn(viewer)).length === 0)
    await browser.pause(300)
    expect(Math.abs((await place()) - before)).toBeLessThanOrEqual(1)
  })

  it("keeps the blank in its spread, so the next file opens the next one", async () => {
    await seedSettings({
      organize: { bookmarks: true, smartPadding: true },
      ui: { language: "en", viewMode: "book" },
    })
    await refreshApp()
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(3)

    await browser.waitUntil(async () => {
      const spreads = await browser.execute(
        (selector: string) =>
          Array.from(document.querySelectorAll(`${selector} [data-book-spread]`), (spread) =>
            Array.from(spread.children, (child) =>
              child.hasAttribute("data-padding-after")
                ? "blank"
                : (child.getAttribute("data-page-number") ?? "?"),
            ).join(","),
          ),
        viewer,
      )

      return spreads.join(" | ") === "1,blank | 2,3"
    })
  })

  it("prints the blank, and a Save As writes it", async () => {
    const own = await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(2))])
    await waitForPages(3)

    await browser.execute(() => {
      const seam = window as Window & { __tfolioE2E?: E2eOverrides; __tfolioPrints?: number }

      seam.__tfolioPrints = 0
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        printWindow: () => {
          seam.__tfolioPrints = (seam.__tfolioPrints ?? 0) + 1

          return Promise.resolve()
        },
      }
    })
    await clickAppMenuItem("print")
    await browser.waitUntil(
      () =>
        browser.execute(
          () => ((window as Window & { __tfolioPrints?: number }).__tfolioPrints ?? 0) > 0,
        ),
      { timeout: 60_000, timeoutMsg: "the print dialog was never asked for" },
    )
    expect(
      await browser.execute(() =>
        Array.from(document.querySelectorAll("[data-print-sheet] .pdf-print-page"), (sheet) =>
          sheet.querySelector("img") ? "page" : "blank",
        ),
      ),
    ).toEqual(["page", "blank", "page", "page"])

    await pointSaveAsAt(path.join(path.dirname(own), "padded.pdf"))
    await $(saveTrigger).click()
    await browser.waitUntil(
      async () =>
        (await $$(`//button[@role='tab'][normalize-space()='padded.pdf']`).length) === 1,
      { timeout: 30_000, timeoutMsg: "the tab never became the saved file" },
    )
    // Saved, the blank is a page of the file like any other.
    await waitForPages(4)
    expect(await blanksIn(activeSidebar)).toEqual([])
  })
})
