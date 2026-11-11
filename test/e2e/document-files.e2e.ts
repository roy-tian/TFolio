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

function pageCount(scope = activeSidebar) {
  return browser.execute(
    (within: string) => document.querySelectorAll(`${within} button[data-thumbnail-page]`).length,
    scope,
  )
}

async function waitForPages(count: number, scope = activeSidebar) {
  await browser.waitUntil(async () => (await pageCount(scope)) === count, {
    timeout: 30_000,
    timeoutMsg: `the document never held ${count} pages`,
  })
}

/** The file names heading the pages, top to bottom. */
function headings(scope = activeSidebar) {
  return browser.execute(
    (within: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(`${within} [data-section-header]`),
        (heading) => heading.textContent ?? "",
      ),
    scope,
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
          file = element.textContent ?? ""
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

function chosen(scope: string) {
  return browser.execute(
    (within: string) =>
      Array.from(
        document.querySelectorAll(`${within} button[data-thumbnail-page][aria-pressed='true']`),
        (button) => Number(button.getAttribute("data-thumbnail-page")),
      ).sort((left, right) => left - right),
    scope,
  )
}

async function addFilesFromPicker(paths: string[]) {
  await pointMultiPickerAt(paths)
  await $(`${activeSidebar} [data-slot='pages-add-files']`).click()
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
    await $(`${activeSidebar} button[aria-label='Files']`).click()
    const files = $(`${activeSidebar} [data-slot='file-sections']`)
    await expect(files).toHaveText(expect.stringContaining("second.pdf"))
    await expect(files).toHaveText(expect.stringContaining("Second half"))
    await $(`${activeSidebar} button[aria-label='Pages']`).click()

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
    await $(`${activeSidebar} [data-slot='pages-add-files']`).click()

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

  it("adds files from the app's menu and from under the tree of files", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await waitForPages(1)

    await pointMultiPickerAt([writeScratchPdf("menu.pdf", minimalPdf(1))])
    await clickAppMenuItem("add-files")
    await waitForPages(2)

    await $(`${activeSidebar} button[aria-label='Files']`).click()
    await pointMultiPickerAt([writeScratchPdf("tree.pdf", minimalPdf(1))])
    await $(`${activeSidebar} [data-slot='files-add']`).click()
    await browser.waitUntil(
      async () => (await treeFiles()).join() === "own.pdf,menu.pdf,tree.pdf",
      { timeout: 30_000, timeoutMsg: "the tree never listed the three files" },
    )
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
    await expect($("[data-testid='pages-drop']")).toHaveAttribute("data-over", "")
    await emitDrag("drag-drop", point, [dropped])
    await waitForPages(5)
    expect(await headings()).toEqual(["own.pdf", "dropped.pdf"])
    // Added to this document, not opened beside it.
    expect((await $$("[data-document-tab]").getElements()).length).toBe(1)
  })

  it("adds files dropped between two pages of the grid there", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(2))
    await $(`${session} button[aria-label='Thumbnails']`).click()
    const grid = `${session} [data-page-thumbnails='grid']`
    await waitForPages(2, grid)
    // Over the second page's left edge: the gap in front of it.
    const point = await browser.execute((scope: string) => {
      const box = document
        .querySelector(`${scope} button[data-thumbnail-page='2']`)!
        .getBoundingClientRect()

      return { x: box.left + 8, y: box.top + box.height / 2 }
    }, grid)
    const dropped = writeScratchPdf("between.pdf", minimalPdf(3, "0 0 300 200"))

    await emitDrag("drag-over", point, [dropped])
    await expect($("[data-testid='pages-drop-marker']")).toBeDisplayed()
    // Over the grid nothing offers to open the files: only the tab strip
    // says where a drop would, and the grid that this one joins the document.
    await expect($("[data-testid='workspace-file-drop']")).toHaveAttribute("data-strip", "")
    await emitDrag("drag-drop", point, [dropped])
    await waitForPages(5, grid)
    expect(await headings(grid)).toEqual(["own.pdf", "between.pdf", "own.pdf"])
    // The tree lists the parted file as the grid heads it, and a Save As writes it.
    expect(await treeFiles()).toEqual(["own.pdf", "between.pdf", "own.pdf"])

    await browser.keys(["Control", "z"])
    await waitForPages(2, grid)
  })

  it("renames a file and removes one, each undoably", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)
    await $(`${activeSidebar} button[aria-label='Files']`).click()

    await press(`${activeSidebar} [data-section-id='1'] [data-slot='file-section-rename']`)
    const input = $(`${activeSidebar} [data-slot='file-section-title-input']`)
    await input.setValue("Appendix")
    await browser.keys("Enter")
    await expect($(`${activeSidebar} [data-section-id='1']`)).toHaveText(
      expect.stringContaining("Appendix"),
    )

    await press(`${activeSidebar} [data-section-id='1'] [data-slot='file-section-remove']`)
    await expect($(`${activeSidebar} [data-section-id='1']`)).not.toBeExisting()
    await $(`${activeSidebar} button[aria-label='Pages']`).click()
    await waitForPages(2)

    await browser.keys(["Control", "z"])
    await waitForPages(4)
    await browser.keys(["Control", "z"])
    await $(`${activeSidebar} button[aria-label='Files']`).click()
    await expect($(`${activeSidebar} [data-section-id='1']`)).toHaveText(
      expect.stringContaining("first.pdf"),
    )
  })

  it("renames, chooses and removes a file from its name's menu", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("first.pdf", minimalPdf(2))])
    await waitForPages(3)
    await $(`${session} button[aria-label='Thumbnails']`).click()
    const grid = `${session} [data-page-thumbnails='grid']`
    await waitForPages(3, grid)

    // A page chosen, to prove the name's keys are the name's: Backspace in
    // the grid deletes what is chosen.
    await $(`${grid} button[data-thumbnail-page='1']`).click()
    await contextMenuAction(`${grid} [data-section-header='1'] button`, "rename-file")
    const input = $(`${grid} [data-slot='file-section-title-input']`)
    await input.waitForDisplayed()
    await expect(input).toBeFocused()
    await browser.keys("Backspace")
    await input.setValue("Appendix")
    await browser.keys("Enter")
    await browser.waitUntil(async () => (await headings(grid)).join() === "own.pdf,Appendix", {
      timeoutMsg: "the heading never took the typed name",
    })
    expect(await pageCount(grid)).toBe(3)

    // Beside the grid the tree's menu chooses the file's pages there.
    await contextMenuAction(
      `${activeSidebar} [data-section-id='1'] [data-slot='file-section-row']`,
      "select-file",
    )
    expect(await chosen(grid)).toEqual([2, 3])

    await contextMenuAction(
      `${activeSidebar} [data-section-id='1'] [data-slot='file-section-row']`,
      "rename-file",
    )
    const treeInput = $(`${activeSidebar} [data-slot='file-section-title-input']`)
    await treeInput.waitForDisplayed()
    await expect(treeInput).toBeFocused()
    await browser.keys("Escape")

    await contextMenuAction(`${grid} [data-section-header='1'] button`, "remove-file")
    await waitForPages(1, grid)
    await browser.keys(["Control", "z"])
    await waitForPages(3, grid)
  })

  it("chooses a file's pages by its name, and carries them whole by it", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)
    await $(`${session} button[aria-label='Thumbnails']`).click()
    const grid = `${session} [data-page-thumbnails='grid']`
    await waitForPages(4, grid)

    await $(`${grid} [data-section-header='1'] button`).click()
    expect(await chosen(grid)).toEqual([2, 3])

    await dragOnto(
      `${grid} [data-section-header='2'] button`,
      `${grid} button[data-thumbnail-page='1']`,
      "left",
    )
    await browser.waitUntil(
      async () => (await headings(grid)).join() === "second.pdf,own.pdf,first.pdf",
      { timeout: 15_000, timeoutMsg: "the file never moved whole to the front" },
    )

    await browser.keys(["Control", "z"])
    await browser.waitUntil(
      async () => (await headings(grid)).join() === "own.pdf,first.pdf,second.pdf",
    )
  })

  it("moves a file whole by dragging its name in the sidebar's tree", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([
      writeScratchPdf("first.pdf", minimalPdf(2)),
      writeScratchPdf("second.pdf", minimalPdf(1)),
    ])
    await waitForPages(4)
    await $(`${activeSidebar} button[aria-label='Files']`).click()

    await dragOnto(
      `${activeSidebar} [data-section-id='2'] [data-slot='file-section-title']`,
      `${activeSidebar} [data-section-id='0']`,
      "top",
    )
    await $(`${activeSidebar} button[aria-label='Pages']`).click()
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
    await contextMenuAction(`${activeSidebar} [data-section-header='1'] button`, "paste-file-end")
    await browser.waitUntil(
      async () => (await pageFiles()).join() === "own.pdf,added.pdf,added.pdf,added.pdf",
      { timeout: 15_000, timeoutMsg: "the pasted page never closed the added file" },
    )

    // From the name in the files' tree: before the file's first page.
    await sidebarPageAction(4, "cut-pages")
    await $(`${activeSidebar} button[aria-label='Files']`).click()
    await contextMenuAction(
      `${activeSidebar} [data-section-id='0'] [data-slot='file-section-row']`,
      "paste-file-start",
    )
    await $(`${activeSidebar} button[aria-label='Pages']`).click()
    await browser.waitUntil(
      async () => (await pageFiles()).join() === "own.pdf,own.pdf,added.pdf,added.pdf",
      { timeout: 15_000, timeoutMsg: "the pasted page never opened the document's own file" },
    )
  })

  it("shows the bookmarks of the one file left", async () => {
    await openPdfFromDisk("own.pdf", minimalPdf(1))
    await addFilesFromPicker([writeScratchPdf("added.pdf", outlinedPdf())])
    await waitForPages(3)
    await $(`${activeSidebar} button[aria-label='Files']`).click()

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
    await $(`${activeSidebar} button[aria-label='Bookmarks']`).click()
    const bookmarks = $(`${activeSidebar} nav[aria-label='Bookmarks']`)
    await expect(bookmarks).toHaveText(expect.stringContaining("own.pdf"))
    await expect(bookmarks).toHaveText(expect.stringContaining("added.pdf"))
    await expect(bookmarks).toHaveText(expect.stringContaining("Second half"))
    expect(own.endsWith("own.pdf")).toBe(true)
  })

  it("keeps the tab on the page grid through the Save As that puts the file in it", async () => {
    const own = await openPdfFromDisk("own.pdf", minimalPdf(2))
    await addFilesFromPicker([writeScratchPdf("added.pdf", minimalPdf(1))])
    await waitForPages(3)
    await $(`${session} button[aria-label='Thumbnails']`).click()
    const grid = `${session} [data-page-thumbnails='grid']`
    await waitForPages(3, grid)

    await pointSaveAsAt(path.join(path.dirname(own), "arranged.pdf"))
    await $(saveTrigger).click()
    await browser.waitUntil(
      async () =>
        (await $$(`//button[@role='tab'][normalize-space()='arranged.pdf']`).length) === 1,
      { timeout: 30_000, timeoutMsg: "the tab never became the saved file" },
    )
    // The grid is the tab's, and the written file took the tab's place: the
    // reader arranging pages is not sent back to reading them. The old tab
    // takes the file's name before the file is read back, so its headings
    // going is what tells the two apart.
    await browser.waitUntil(async () => (await headings(grid)).length === 0, {
      timeout: 30_000,
      timeoutMsg: "the tab never showed the saved file as one file",
    })
    await waitForPages(3, grid)
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
    await $(`${session} button[aria-label='Thumbnails']`).click()
    const grid = `${session} [data-page-thumbnails='grid']`
    await waitForPages(4, grid)
    expect(await blanksIn(grid)).toEqual([])

    // The document's first page held past the added file's last: its own
    // file would be left one page, which a blank then backs.
    await holdPageAfter(grid, 1, 4)
    await browser.waitUntil(async () => (await blanksIn(grid)).join() === "2", {
      timeoutMsg: "the held page never showed the blank its drop would add",
    })

    await letGoOfPage()
    await browser.waitUntil(async () => (await blanksIn(grid)).join() === "1", {
      timeout: 15_000,
      timeoutMsg: "the drop never laid the blank out after the one page left",
    })
    await $(`${session} button[aria-label='Single page']`).click()
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
