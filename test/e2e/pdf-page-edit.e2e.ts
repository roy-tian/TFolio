import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import {
  appMenuItemEnabled,
  bandedPdf,
  clickAppMenuItem,
  emitDrag,
  gapPoint,
  openPdfFromDisk,
  openPathViaDialog,
  stripedPdf,
  writeScratchPdf,
} from "./helpers"

function thumbCount() {
  return browser.execute(
    () => document.querySelectorAll("button[data-page-number]").length,
  )
}

/**
 * A position-sensitive digest of one thumbnail's pixels — what proves which
 * page now sits in a cell, rather than merely that some page does. -1 is a
 * missing cell; -2 a canvas not painted yet, which reads back as solid black
 * and would otherwise pass for a heavily inked page; 0 a painted blank page.
 */
function thumbFingerprint(pageNumber: number) {
  return browser.execute((page: number) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `button[data-page-number='${page}'] canvas`,
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
  }, pageNumber)
}

async function waitForThumb(pageNumber: number, fingerprint: number) {
  try {
    await browser.waitUntil(
      async () => (await thumbFingerprint(pageNumber)) === fingerprint,
      {
        timeout: 15_000,
        timeoutMsg: `cell ${pageNumber} never showed the expected page`,
      },
    )
  } catch (error) {
    const cells = []

    for (let cell = 1; cell <= 8; cell += 1) {
      cells.push(await thumbFingerprint(cell))
    }

    console.log(
      `WAIT FAILED cell=${pageNumber} expected=${fingerprint} cells=${JSON.stringify(cells)}`,
    )
    throw error
  }
}

/** Every cell painted and distinct, handed back as position -> fingerprint. */
async function paintedFingerprints(pageCount: number) {
  const fingerprints: number[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    await browser.waitUntil(
      async () => (await thumbFingerprint(pageNumber)) > 0,
      {
        timeout: 15_000,
        timeoutMsg: `cell ${pageNumber} never painted`,
      },
    )
    fingerprints.push(await thumbFingerprint(pageNumber))
  }

  expect(new Set(fingerprints).size).toBe(pageCount)

  return fingerprints
}

/** Whether the gap shows the solid line that marks where a drop would land. A
    wrapped gap is drawn twice — at the end of one row and the start of the next
    — so any one of them showing is the answer. */
function dropLineShowing(index: number) {
  return browser.execute(
    (at: number) =>
      document.querySelectorAll(`[data-insert-index='${at}'] .border-solid`)
        .length > 0,
    index,
  )
}

/**
 * A click with modifiers, dispatched rather than driven: WebDriver's own click
 * cannot hold Ctrl or Shift down for it.
 */
function clickThumb(
  pageNumber: number,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
) {
  return browser.execute(
    (page: number, mods: { ctrl?: boolean; shift?: boolean }) => {
      document
        .querySelector(`button[data-page-number='${page}']`)!
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
  )
}

function selectedThumbs() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll("button[data-page-number][aria-pressed='true']"),
      (button) => Number(button.getAttribute("data-page-number")),
    ).sort((left, right) => left - right),
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

describe("TFolio page editing", () => {
  beforeEach(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "thumbnail")
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
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

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the undo never restored the page",
    })
    await waitForThumb(2, second!)
    await waitForThumb(4, fourth!)

    await $("button[aria-label='Redo']").click()
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

    await $("button[aria-label='Insert a blank page before page 2']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the insert never landed",
    })
    // The new page renders blank; its neighbours moved over intact.
    await waitForThumb(2, 0)
    await waitForThumb(1, first!)
    await waitForThumb(3, second!)

    await $("button[aria-label='Insert a blank page at the end']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 5, {
      timeoutMsg: "the end insert never landed",
    })
    await waitForThumb(5, 0)

    await $("button[aria-label='Undo']").click()
    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "undoing both inserts never restored the shape",
    })
    await waitForThumb(2, second!)
  })

  it("inserts a PDF dragged in from the desktop at the gap under it", async () => {
    await openPdfFromDisk("drop.pdf", bandedPdf(3))
    const [first, second, third] = await paintedFingerprints(3)
    const filePath = writeScratchPdf("dropped.pdf", stripedPdf())
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
    await waitForThumb(3, second!)
    await waitForThumb(4, third!)
    const inserted = await thumbFingerprint(2)
    expect(inserted).not.toBe(0)
    expect([first, second, third]).not.toContain(inserted)

    // The file joined this document at the gap rather than opening a tab.
    await expect($$("button[role='tab']")).toBeElementsArrayOfSize(2)
    // Another file's pages are in the document, so it may only be exported as a
    // copy — never written back over the file it was opened from.
    expect(await appMenuItemEnabled("save")).toBe(false)
    expect(await appMenuItemEnabled("save-as")).toBe(true)

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the undo never took the inserted page back out",
    })
    await waitForThumb(2, second!)
  })

  it("drags pages into a new order and undoes it", async () => {
    await openPdfFromDisk("reorder.pdf", bandedPdf(4))
    const [first, second, third, fourth] = await paintedFingerprints(4)

    // Page 1 dropped before page 3: [2, 1, 3, 4].
    await dragThumbToGap(1, 3)
    await waitForThumb(1, second!)
    await waitForThumb(2, first!)

    await $("button[aria-label='Undo']").click()
    await waitForThumb(1, first!)
    await waitForThumb(2, second!)

    // A shift-selected pair drags as one block, to past the end: [3, 4, 1, 2].
    await clickThumb(1)
    await clickThumb(2, { shift: true })
    await dragThumbToGap(1, 4, true)
    await waitForThumb(1, third!)
    await waitForThumb(2, fourth!)
    await waitForThumb(3, first!)
    await waitForThumb(4, second!)
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
    await browser.refresh()
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "thumbnail")
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await openPathViaDialog(filePath)
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the reopened file lost its shape",
    })
    await waitForThumb(1, fourth!)
    await waitForThumb(2, second!)
  })
})
