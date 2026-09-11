import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  appMenuItemEnabled,
  bandedPdf,
  clickAppMenuItem,
  emitDrag,
  gapPoint,
  hoverElement,
  openPathViaDialog,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
  stripedPdf,
  tooltipOn,
  tooltipOpen,
} from "./helpers"

/** The panel on screen. Only its cells have a layout, and only its document is
    the one a gesture means — an unscoped query would find a hidden tab's grid
    first, since it is still in the tree. */
const ACTIVE_GRID = "[data-document-session][data-active='true']"

function thumbCount(scope = "") {
  return browser.execute(
    (within: string) =>
      document.querySelectorAll(`${within} button[data-page-number]`).length,
    scope,
  )
}

/**
 * A position-sensitive digest of one thumbnail's pixels — what proves which
 * page now sits in a cell, rather than merely that some page does. -1 is a
 * missing cell; -2 a canvas not painted yet, which reads back as solid black
 * and would otherwise pass for a heavily inked page; 0 a painted blank page.
 */
function thumbFingerprint(pageNumber: number, scope = "") {
  return browser.execute((page: number, within: string) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `${within} button[data-page-number='${page}'] canvas`,
    )

    if (!canvas) {
      return -1
    }

    const { data } = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height)
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
  }, pageNumber, scope)
}

async function waitForThumb(
  pageNumber: number,
  fingerprint: number,
  scope = "",
) {
  try {
    await browser.waitUntil(
      async () => (await thumbFingerprint(pageNumber, scope)) === fingerprint,
      {
        timeout: 15_000,
        timeoutMsg: `cell ${pageNumber} never showed the expected page`,
      },
    )
  } catch (error) {
    const cells = []

    for (let cell = 1; cell <= 8; cell += 1) {
      cells.push(await thumbFingerprint(cell, scope))
    }

    console.log(
      `WAIT FAILED cell=${pageNumber} expected=${fingerprint} cells=${JSON.stringify(cells)}`,
    )
    throw error
  }
}

/** Every cell painted and distinct, handed back as position -> fingerprint. */
async function paintedFingerprints(pageCount: number, scope = "") {
  const fingerprints: number[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    // Assigning a canvas its size clears it, so a cell read the instant it
    // first paints can come back blank the moment after. Two equal readings
    // are what say the bitmap has settled — and the reading kept is one of
    // them, rather than a third taken after the wait.
    let previous = -1
    let settled = -1

    await browser.waitUntil(
      async () => {
        const current = await thumbFingerprint(pageNumber, scope)
        // 0 is a painted blank page, not a miss — only the negatives are
        // sentinels.
        const painted = current >= 0 && current === previous

        previous = current
        settled = current

        return painted
      },
      {
        // Generous because a parallel run's lanes share this machine; a
        // repaint queue can outlast the wait an idle machine never needs.
        timeout: 30_000,
        timeoutMsg: `cell ${pageNumber} never painted`,
      },
    )
    fingerprints.push(settled)
  }

  expect(new Set(fingerprints).size).toBe(pageCount)

  return fingerprints
}

/** Whether the gap shows the solid line that marks where a drop would land. A
    wrapped gap is drawn twice — at the end of one row and the start of the next
    — so any one of them showing is the answer. */
function dropLineShowing(index: number, scope = "") {
  return browser.execute(
    (at: number, within: string) =>
      document.querySelectorAll(
        `${within} [data-insert-index='${at}'] .border-solid`,
      ).length > 0,
    index,
    scope,
  )
}

/**
 * A click with modifiers, dispatched rather than driven: WebDriver's own click
 * cannot hold Ctrl or Shift down for it.
 */
function clickThumb(
  pageNumber: number,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
  scope = "",
) {
  return browser.execute(
    (page: number, mods: { ctrl?: boolean; shift?: boolean }, within: string) => {
      document
        .querySelector(`${within} button[data-page-number='${page}']`)!
        .dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            ctrlKey: Boolean(mods.ctrl),
            shiftKey: Boolean(mods.shift),
          }),
        )
    },
    pageNumber,
    modifiers,
    scope,
  )
}

/** The grid's own editing keys. Dispatched rather than typed: this driver
    cannot hold Ctrl down, and the grid listens on the document either way. */
function pressEditKey(key: string) {
  return browser.execute((pressed: string) => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: pressed,
      }),
    )
  }, key)
}

/** The right-click a page answers with its cut-and-copy menu. */
async function openThumbMenu(pageNumber: number) {
  await browser.execute((page: number) => {
    const thumb = document.querySelector(`button[data-page-number='${page}']`)!
    const box = thumb.getBoundingClientRect()

    thumb.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        clientX: box.left + 20,
        clientY: box.top + 20,
      }),
    )
  }, pageNumber)
  await $("[data-action='cut-pages']").waitForDisplayed({ timeout: 5_000 })
}

function selectedThumbs() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll("button[data-page-number][aria-pressed='true']"),
      (button) => Number(button.getAttribute("data-page-number")),
    ).sort((left, right) => left - right),
  )
}

/** Each cell's shape as the grid draws it: a page turned a quarter of the way
    round stands in a landscape box where an upright one is portrait. */
function thumbShapes(scope = "") {
  return browser.execute(
    (within: string) =>
      Array.from(
        document.querySelectorAll(`${within} button[data-page-number]`),
        (cell) => {
          const box = cell.getBoundingClientRect()

          return box.width > box.height ? "landscape" : "portrait"
        },
      ),
    scope,
  )
}

function pageRotations() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>("[data-page-number]"),
      (page) => Number(page.dataset.rotation),
    ),
  )
}

/**
 * Drags a thumbnail the way a reader would — press, move past the threshold,
 * drop in a gap — with dispatched pointer events, which under WebKitGTK are
 * the only press semantics a test can produce (the M3 lesson).
 */
function dragThumbToGap(from: number, target: number, pastEnd = false) {
  return browser.execute(
    (f: number, t: number, end: boolean) => {
      const cell = (page: number) =>
        document.querySelector(`button[data-page-number='${page}']`)!
      const fromBox = cell(f).getBoundingClientRect()
      const targetBox = cell(t).getBoundingClientRect()
      const start = {
        x: fromBox.left + fromBox.width / 2,
        y: fromBox.top + fromBox.height / 2,
      }
      // The left quarter of a cell is the gap before it; past the right edge
      // of the last cell is the gap after everything.
      const dest = end
        ? { x: targetBox.right + 4, y: targetBox.top + targetBox.height / 2 }
        : { x: targetBox.left + 8, y: targetBox.top + targetBox.height / 2 }

      cell(f).dispatchEvent(
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
          clientX: start.x + 12,
          clientY: start.y,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          clientX: dest.x,
          clientY: dest.y,
        }),
      )
      document.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          clientX: dest.x,
          clientY: dest.y,
        }),
      )
    },
    from,
    target,
    pastEnd,
  )
}

/** Presses the active grid's page `from` and takes it past the drag threshold,
    which is where a press becomes a drag rather than a click. */
function pressThumb(from: number) {
  return browser.execute((page: number, within: string) => {
    const paper = document.querySelector(
      `${within} button[data-page-number='${page}']`,
    )!
    const box = paper.getBoundingClientRect()
    const start = { x: box.left + box.width / 2, y: box.top + box.height / 2 }

    paper.dispatchEvent(
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
        clientX: start.x + 20,
        clientY: start.y + 8,
      }),
    )
  }, from, ACTIVE_GRID)
}

function movePointer(
  kind: "pointermove" | "pointerup",
  point: { x: number; y: number },
) {
  return browser.execute(
    (name: string, x: number, y: number) => {
      document.dispatchEvent(
        new PointerEvent(name, { bubbles: true, clientX: x, clientY: y }),
      )
    },
    kind,
    point.x,
    point.y,
  )
}

/** The middle of the tab of the document that is not on screen. */
function otherTabPoint() {
  return browser.execute(() => {
    const active = document
      .querySelector("[data-document-session][data-active='true']")!
      .getAttribute("data-document-session")
    const tab = Array.from(
      document.querySelectorAll<HTMLElement>("[data-document-tab]"),
    ).find((candidate) => candidate.dataset.documentTab !== active)!
    const box = tab.getBoundingClientRect()

    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
}

/** The middle of an insert zone in the grid on screen — `gapPoint`'s answer for
    a workspace holding more than one document. */
function activeGapPoint(index: number) {
  return browser.execute(
    (at: number, within: string) => {
      const box = document
        .querySelector(`${within} [data-insert-index='${at}']`)!
        .getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    },
    index,
    ACTIVE_GRID,
  )
}

function activeDocumentId() {
  return browser.execute(() =>
    document
      .querySelector("[data-document-session][data-active='true']")
      ?.getAttribute("data-document-session"),
  )
}

describe("TFolio page editing", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await refreshApp()
  })

  it("selects with click, ctrl+click, and shift+click", async () => {
    await openPdfFromDisk("select.pdf", bandedPdf(4))
    await paintedFingerprints(4)

    await clickThumb(2)
    expect(await selectedThumbs()).toEqual([2])

    // The selection ring is a real visual, not just an attribute.
    const shadows = await browser.execute(() => {
      const shadowOf = (page: number) =>
        getComputedStyle(
          document.querySelector(`button[data-page-number='${page}']`)!,
        ).boxShadow

      return { selected: shadowOf(2), unselected: shadowOf(1) }
    })
    expect(shadows.selected).not.toBe(shadows.unselected)

    await clickThumb(4, { ctrl: true })
    expect(await selectedThumbs()).toEqual([2, 4])

    // The toggle moved the anchor to 4, so shift spans 1 through 4.
    await clickThumb(1, { shift: true })
    expect(await selectedThumbs()).toEqual([1, 2, 3, 4])

    await clickThumb(3)
    expect(await selectedThumbs()).toEqual([3])

    await browser.execute(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      )
    })
    expect(await selectedThumbs()).toEqual([])
  })

  it("turns the grid's chosen pages in the document, undoably", async () => {
    await openPdfFromDisk("rotate.pdf", bandedPdf(4))
    const [, upright] = await paintedFingerprints(4)
    const rotate = () => $("button[aria-label='Rotate clockwise']").click()

    // A partial selection is the target, and what turns is the page rather than
    // the way it is being looked at: the cell takes a landscape box while the
    // viewer's own rotation stays where it was.
    await clickThumb(2)
    await rotate()
    await browser.waitUntil(
      async () => (await thumbShapes())[1] === "landscape",
      { timeoutMsg: "the page never turned" },
    )
    expect(await thumbShapes()).toEqual([
      "portrait",
      "landscape",
      "portrait",
      "portrait",
    ])
    expect(await pageRotations()).toEqual([0, 0, 0, 0])
    // Turned in the document, so the bitmap the backend draws is a turned one
    // rather than the same picture in a box on its side.
    await browser.waitUntil(
      async () => {
        const print = await thumbFingerprint(2)

        return print > 0 && print !== upright
      },
      { timeoutMsg: "the turned page never painted again" },
    )
    // The page turned where it stands, so the selection still names it — and
    // the history is holding the turn, named for what it did.
    expect(await selectedThumbs()).toEqual([2])
    await expect(
      $("button[aria-label='Undo turning a page']"),
    ).toBeExisting()

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(
      async () => (await thumbShapes())[1] === "portrait",
      { timeoutMsg: "the undo never turned the page back" },
    )

    // The page's own menu makes the same edit, and takes an unselected page to
    // the selection first, as cut and copy do.
    await openThumbMenu(3)
    await $("[data-action='rotate-pages']").click()
    await browser.waitUntil(
      async () => (await thumbShapes())[2] === "landscape",
      { timeoutMsg: "the menu never turned the page" },
    )
    expect(await selectedThumbs()).toEqual([3])
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(
      async () => (await thumbShapes())[2] === "portrait",
      { timeoutMsg: "the undo never turned the menu's page back" },
    )

    // Blank workspace clears the selection, so the next press turns every page.
    await browser.execute(() => {
      document
        .querySelector("[data-pdf-viewer-layout]")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(await selectedThumbs()).toEqual([])
    await rotate()
    await browser.waitUntil(
      async () => (await thumbShapes()).every((shape) => shape === "landscape"),
      { timeoutMsg: "the whole document never turned" },
    )
    await expect(
      $("button[aria-label='Undo turning 4 pages']"),
    ).toBeExisting()

    // Reading views go on turning the view alone, on top of whatever the pages
    // now carry of their own.
    await $("button[aria-label='Single page']").click()
    await rotate()
    expect(await pageRotations()).toEqual([90, 90, 90, 90])
  })

  it("deletes pages, undoes them back, and redoes the delete", async () => {
    await openPdfFromDisk("delete.pdf", bandedPdf(4))
    const [first, second, third, fourth] = await paintedFingerprints(4)

    // Deleting an unselected page takes that page alone.
    await clickThumb(2)
    await $("button[aria-label='Delete page 2']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the delete never landed",
    })
    await waitForThumb(2, third!)

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the undo never restored the page",
    })
    await waitForThumb(2, second!)
    await waitForThumb(4, fourth!)

    await $("button[aria-label^='Redo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the redo never deleted again",
    })
    await waitForThumb(1, first!)
    await waitForThumb(2, third!)

    // Deleting a selected page takes the whole selection with it.
    await clickThumb(1)
    await clickThumb(3, { ctrl: true })
    await $("button[aria-label='Delete 2 selected pages']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 1, {
      timeoutMsg: "the selection delete never landed",
    })
    await waitForThumb(1, third!)

    // The last page's own button is disabled: a document keeps one page.
    await expect($("button[aria-label='Delete page 1']")).toBeDisabled()
  })

  it("inserts blank pages in the gaps and undoes them", async () => {
    await openPdfFromDisk("insert.pdf", bandedPdf(3))
    const [first, second] = await paintedFingerprints(3)

    // The gap only shows where a page would go — the + it draws is the button
    // — so a click that lands beside a page adds nothing. What says so is the
    // count at the end of this test rather than one taken here: an insert is a
    // round trip, so the grid is still three pages long either way for as long
    // as a synchronous read can see.
    await browser.execute(() => {
      document
        .querySelector("[data-insert-index='2']")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })

    await $("button[aria-label='Insert a blank page before page 2']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the insert never landed",
    })
    // The new page renders blank; its neighbours moved over intact.
    await waitForThumb(2, 0)
    await waitForThumb(1, first!)
    await waitForThumb(3, second!)
    // Three round trips later: the + inserted one page, the click on the gap
    // beside it none.
    expect(await thumbCount()).toBe(4)

    await $("button[aria-label='Insert a blank page at the end']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 5, {
      timeoutMsg: "the end insert never landed",
    })
    await waitForThumb(5, 0)

    await $("button[aria-label^='Undo']").click()
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "undoing both inserts never restored the shape",
    })
    await waitForThumb(2, second!)
  })

  it("cuts a selection and pastes it into a gap as one move", async () => {
    await openPdfFromDisk("cut.pdf", bandedPdf(4))
    const [first, second, third, fourth] = await paintedFingerprints(4)

    await clickThumb(2)
    await clickThumb(3, { ctrl: true })
    expect(await selectedThumbs()).toEqual([2, 3])

    await openThumbMenu(2)
    await $("[data-action='cut-pages']").click()
    await expect($("[data-page-notice]")).toHaveText("2 pages cut (2–3)")

    // A cut takes nothing away by itself: the pages are still there, waiting
    // for somewhere to go.
    expect(await thumbCount()).toBe(4)
    await waitForThumb(2, second!)

    await $("button[aria-label='Paste at the end']").click()
    await browser.waitUntil(async () => (await thumbFingerprint(2)) === fourth, {
      timeoutMsg: "the paste never moved the pages",
    })
    await waitForThumb(3, second!)
    await waitForThumb(4, third!)
    expect(await thumbCount()).toBe(4)
    await expect($("[data-page-notice]")).toHaveText("2 pages moved to the end")

    // One undo: the move is one edit, whatever the reader spent on it.
    await $("button[aria-label^='Undo']").click()
    await waitForThumb(1, first!)
    await waitForThumb(2, second!)
    await waitForThumb(4, fourth!)

    // The cut is spent, so no gap offers a paste any more.
    expect(await $$("button[aria-label='Paste at the end']").length).toBe(0)
  })

  it("copies pages with the keyboard and pastes them again and again", async () => {
    await openPdfFromDisk("copy.pdf", bandedPdf(3))
    const [first, second, third] = await paintedFingerprints(3)

    await clickThumb(3)
    expect(await selectedThumbs()).toEqual([3])
    await pressEditKey("c")
    await expect($("[data-page-notice]")).toHaveText("Page 3 copied")

    // Ctrl+V lands in front of the page the reader has chosen.
    await clickThumb(1)
    expect(await selectedThumbs()).toEqual([1])
    await pressEditKey("v")
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the paste never landed",
    })
    await waitForThumb(1, third!)
    await waitForThumb(2, first!)
    await expect($("[data-page-notice]")).toHaveText(
      "1 page pasted before page 1",
    )

    // The copy stands, and it follows the page its own paste pushed down: the
    // second paste brings the same page over again.
    await $("button[aria-label='Paste at the end']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 5, {
      timeoutMsg: "the second paste never landed",
    })
    await waitForThumb(5, third!)

    await $("button[aria-label^='Undo']").click()
    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "undoing both pastes never restored the shape",
    })
    await waitForThumb(1, first!)
    await waitForThumb(2, second!)

    // Every other edit voids the clipboard: its page numbers would now name
    // pages the reader never chose.
    await $("button[aria-label='Insert a blank page at the end']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the insert never landed",
    })
    expect(await $$("button[aria-label='Paste at the end']").length).toBe(0)
  })

  it("labels the grid's controls with shadcn tooltips, not native ones", async () => {
    await openPdfFromDisk("tooltips.pdf", bandedPdf(2))
    await $("button[aria-label='Select page 2']").waitForExist()

    // A pointer crossing the grid must not set one off: unlike a bar's label,
    // the hint waits out a hover that means it.
    await hoverElement("button[aria-label='Select page 2']")
    await browser.pause(250)
    expect(await tooltipOpen("button[aria-label='Select page 2']")).toBe(false)

    for (const label of [
      "Select page 2",
      "Delete page 2",
      "Insert a blank page before page 2",
    ]) {
      const selector = `button[aria-label='${label}']`
      expect(await $(selector).getAttribute("title")).toBeNull()
      expect(await tooltipOn(selector)).toContain(label)
    }
  })

  it("inserts a PDF dragged in from the desktop at the gap under it", async () => {
    // The dropped file opens as a document of its own first, because only a
    // painted canvas can supply the fingerprint its page must reproduce.
    const filePath = await openPdfFromDisk("dropped.pdf", stripedPdf())
    const [dropped] = await paintedFingerprints(1)
    // A reload closes every document, so the drop meets a one-document
    // workspace again — the fingerprint in hand, the extra tab gone.
    await refreshApp()

    await openPdfFromDisk("drop.pdf", bandedPdf(3))
    const [first, second, third] = await paintedFingerprints(3)
    const point = await gapPoint(2)

    await emitDrag("drag-over", point, [filePath])
    await browser.waitUntil(async () => await dropLineShowing(2), {
      timeoutMsg: "the insertion line never marked the gap under the pointer",
    })

    await emitDrag("drag-drop", point, [filePath])
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the dropped PDF never landed in the grid",
    })

    // The file's page opened the gap; the base's pages moved over intact.
    await waitForThumb(1, first!)
    await waitForThumb(2, dropped!)
    await waitForThumb(3, second!)
    await waitForThumb(4, third!)

    // The file joined this document at the gap rather than opening a tab.
    await expect($$("button[role='tab']")).toBeElementsArrayOfSize(2)
    // Another file's pages are in the document, so it may only be exported as a
    // copy — never written back over the file it was opened from.
    expect(await appMenuItemEnabled("save")).toBe(false)
    expect(await appMenuItemEnabled("save-as")).toBe(true)

    await $("button[aria-label^='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the undo never took the inserted page back out",
    })
    await waitForThumb(2, second!)
  })

  it("moves painted thumbnails on drop and undo without waiting for new bitmaps", async () => {
    await openPdfFromDisk("reorder.pdf", bandedPdf(4))
    const [first, second, third, fourth] = await paintedFingerprints(4)

    // Hold decoding, not the PDF mutation: the committed grid must carry its
    // existing canvases into place even when no replacement bitmap can paint.
    await browser.execute(() => {
      const decode = window.createImageBitmap.bind(window)
      let resume!: () => void
      const held = new Promise<void>((resolve) => { resume = resolve })

      window.createImageBitmap = (async (...args: Parameters<typeof decode>) => {
        await held
        return decode(...args)
      }) as typeof window.createImageBitmap

      document.addEventListener("resume-thumbnail-decoding", () => {
        window.createImageBitmap = decode
        resume()
      }, { once: true })
    })

    try {
      // Page 1 dropped before page 3: [2, 1, 3, 4].
      await dragThumbToGap(1, 3)
      await waitForThumb(1, second!)
      await waitForThumb(2, first!)

      await $("button[aria-label^='Undo']").click()
      await waitForThumb(1, first!)
      await waitForThumb(2, second!)

      await $("button[aria-label^='Redo']").click()
      await waitForThumb(1, second!)
      await waitForThumb(2, first!)
      await $("button[aria-label^='Undo']").click()
      await waitForThumb(1, first!)

      // A shift-selected pair drags as one block, past the end: [3, 4, 1, 2].
      await clickThumb(1)
      await clickThumb(2, { shift: true })
      await dragThumbToGap(1, 4, true)
      await waitForThumb(1, third!)
      await waitForThumb(2, fourth!)
      await waitForThumb(3, first!)
      await waitForThumb(4, second!)
      expect(await browser.execute(() =>
        Array.from(document.querySelectorAll("[data-page-cell]"),
          (cell) => getComputedStyle(cell).opacity),
      )).toEqual(["1", "1", "1", "1"])
    } finally {
      await browser.execute(() => {
        document.dispatchEvent(new Event("resume-thumbnail-decoding"))
      })
    }
  })

  it("double-click still leaves the grid for the page itself", async () => {
    await openPdfFromDisk("open-page.pdf", bandedPdf(4))
    await paintedFingerprints(4)

    await browser.execute(() => {
      document
        .querySelector("button[data-page-number='3']")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    })

    await expect($("button[aria-label='Single page']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await browser.waitUntil(
      async () =>
        (await $("input[aria-label='Page number']").getValue()) === "3",
      { timeoutMsg: "the double-clicked page never became current" },
    )
  })

  it("carries pages to another document through its tab", async () => {
    await openPdfFromDisk("into.pdf", bandedPdf(2))
    const [first, second] = await paintedFingerprints(2, ACTIVE_GRID)

    // The newly opened document is the one on screen, so the drag starts here.
    await openPdfFromDisk("from.pdf", stripedPdf())
    const [striped] = await paintedFingerprints(1, ACTIVE_GRID)
    const source = await activeDocumentId()

    // Lift the striped page and rest it on the other document's tab, which is
    // what takes the drag across: one document is on screen at a time.
    await pressThumb(1)
    await movePointer("pointermove", await otherTabPoint())
    await browser.waitUntil(async () => (await activeDocumentId()) !== source, {
      timeout: 5000,
      timeoutMsg: "resting on the other tab never opened it",
    })

    // The grid it opened marks the gap under the pointer, exactly as it would
    // for a PDF dragged in from the desktop.
    const gap = await activeGapPoint(2)
    await movePointer("pointermove", gap)
    await browser.waitUntil(async () => await dropLineShowing(2, ACTIVE_GRID), {
      timeoutMsg: "the insertion line never marked the gap under the pointer",
    })

    await movePointer("pointerup", gap)
    await browser.waitUntil(
      async () => (await thumbCount(ACTIVE_GRID)) === 3,
      { timeoutMsg: "the carried page never landed in the other document" },
    )

    // It opened the gap it was dropped into, and arrived as itself.
    await waitForThumb(1, first!, ACTIVE_GRID)
    await waitForThumb(2, striped!, ACTIVE_GRID)
    await waitForThumb(3, second!, ACTIVE_GRID)

    // Another document's page is in this one, so it may only be exported as a
    // copy — the same guard an inserted file's pages raise.
    expect(await appMenuItemEnabled("save")).toBe(false)
    expect(await appMenuItemEnabled("save-as")).toBe(true)

    await $(`${ACTIVE_GRID} button[aria-label^='Undo']`).click()
    await browser.waitUntil(
      async () => (await thumbCount(ACTIVE_GRID)) === 2,
      { timeoutMsg: "the undo never took the carried page back out" },
    )

    // The pages were copied, not moved: the document they came from still has
    // its own, whatever this one does with them.
    await $(`#workspace-tab-${source}`).click()
    await browser.waitUntil(async () => (await activeDocumentId()) === source, {
      timeoutMsg: "the source document never came back",
    })
    expect(await thumbCount(ACTIVE_GRID)).toBe(1)
    await waitForThumb(1, striped!, ACTIVE_GRID)
  })

  it("carries a whole selected block across, one undo deep", async () => {
    await openPdfFromDisk("into-block.pdf", stripedPdf())
    const [striped] = await paintedFingerprints(1, ACTIVE_GRID)

    // Left on a view with no gaps to drop into: the drag has to bring the
    // document it opens to its grid, or the pages would arrive nowhere. The
    // press is the reader's, so it also becomes what the next open starts in —
    // which is why the document dragged from asks for its own grid back.
    await $(`${ACTIVE_GRID} button[aria-label='Single page']`).click()

    await openPdfFromDisk("from-block.pdf", bandedPdf(3))
    await $(`${ACTIVE_GRID} button[aria-label='Thumbnails']`).click()
    const [first, second] = await paintedFingerprints(3, ACTIVE_GRID)
    const source = await activeDocumentId()

    // The pages in hand are the ones the press took: opening the other tab
    // clears this grid's selection, which must not shrink the block in flight.
    await clickThumb(1, {}, ACTIVE_GRID)
    await clickThumb(2, { shift: true }, ACTIVE_GRID)
    await pressThumb(2)
    await movePointer("pointermove", await otherTabPoint())
    await browser.waitUntil(async () => (await activeDocumentId()) !== source, {
      timeout: 5000,
      timeoutMsg: "resting on the other tab never opened it",
    })

    // It opened on its pages, whatever view it was left in.
    await expect(
      $(`${ACTIVE_GRID} button[aria-label='Thumbnails']`),
    ).toHaveAttribute("aria-pressed", "true")
    await browser.waitUntil(
      async () => (await thumbCount(ACTIVE_GRID)) === 1,
      { timeoutMsg: "the document the drag opened never showed its grid" },
    )

    const gap = await activeGapPoint(2)
    await movePointer("pointermove", gap)
    await movePointer("pointerup", gap)
    await browser.waitUntil(
      async () => (await thumbCount(ACTIVE_GRID)) === 3,
      { timeoutMsg: "the carried block never landed whole" },
    )

    // Both pages landed after the page that was already there, in their order.
    await waitForThumb(1, striped!, ACTIVE_GRID)
    await waitForThumb(2, first!, ACTIVE_GRID)
    await waitForThumb(3, second!, ACTIVE_GRID)

    // One edit, however many pages it brought.
    await $(`${ACTIVE_GRID} button[aria-label^='Undo']`).click()
    await browser.waitUntil(
      async () => (await thumbCount(ACTIVE_GRID)) === 1,
      { timeoutMsg: "the undo never took the whole block back out" },
    )
  })

  it("saves the edited structure into the file itself", async () => {
    const filePath = await openPdfFromDisk("restructure.pdf", bandedPdf(4))
    const [, second, , fourth] = await paintedFingerprints(4)

    // Delete page 1, then bring the last page to the front: [4, 2, 3].
    await clickThumb(1)
    await $("button[aria-label='Delete page 1']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the delete never landed",
    })
    await dragThumbToGap(3, 1)
    await waitForThumb(1, fourth!)

    await clickAppMenuItem("save")
    await browser.waitUntil(async () => !(await appMenuItemEnabled("save")), {
      timeoutMsg: "the save never completed",
    })

    // The saved file, reopened, still reads [4, 2, 3].
    await refreshApp()
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await openPathViaDialog(filePath)
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the reopened file lost its shape",
    })
    await waitForThumb(1, fourth!)
    await waitForThumb(2, second!)
  })
})
