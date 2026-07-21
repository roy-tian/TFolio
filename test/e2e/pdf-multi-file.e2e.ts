import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import type { E2eOverrides } from "../../src/lib/e2e"
import { openPdfFromDisk } from "./helpers"

/**
 * One 200x300 page per band offset, each carrying a black bar at that x — so
 * every page across a merged document renders to a distinct fingerprint.
 */
function bandedPdf(offsets: number[]) {
  const count = offsets.length
  const kids = offsets.map((_, index) => `${3 + index} 0 R`).join(" ")
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${count} >>\nendobj\n`,
  ]

  offsets.forEach((_, index) => {
    objects.push(
      `${3 + index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] ` +
        `/Contents ${3 + count + index} 0 R >>\nendobj\n`,
    )
  })

  offsets.forEach((offset, index) => {
    const content = `0 0 0 rg\n${offset} 100 30 120 re f\n`

    objects.push(
      `${3 + count + index} 0 obj\n<< /Length ${content.length} >>\n` +
        `stream\n${content}endstream\nendobj\n`,
    )
  })

  const chunks = ["%PDF-1.4\n"]
  const offsetsTable: number[] = []
  let byteLength = Buffer.byteLength(chunks[0], "ascii")

  for (const object of objects) {
    offsetsTable.push(byteLength)
    chunks.push(object)
    byteLength += Buffer.byteLength(object, "ascii")
  }

  const xrefOffset = byteLength
  chunks.push(`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n")

  for (const offset of offsetsTable) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }

  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  )

  return Buffer.from(chunks.join(""), "ascii")
}

/** Writes a PDF to disk and merges it through the files view's add-file seam —
    only the picker is stubbed, so the real merge command runs. */
async function mergeFromDisk(fileName: string, contents: Uint8Array) {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-e2e-merge-"))
  const filePath = path.join(directory, fileName)
  writeFileSync(filePath, contents)
  await browser.execute((mockPath: string) => {
    const seam = window as Window & { __tfolioE2E?: E2eOverrides }
    seam.__tfolioE2E = { ...seam.__tfolioE2E, pickPdfPath: () => Promise.resolve(mockPath) }
  }, filePath)
  await $("[data-slot='add-file']").click()
}

function cardCount() {
  return browser.execute(
    () => document.querySelectorAll("[data-file-index]").length,
  )
}

function thumbCount() {
  return browser.execute(
    () => document.querySelectorAll("button[data-page-number]").length,
  )
}

/** Every card's page-count caption, in DOM order. */
function cardCaptions() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll("[data-file-index]"),
      (card) =>
        card.parentElement?.querySelector(".font-mono")?.textContent ?? "",
    ),
  )
}

function fanLeaves(cardPosition: number) {
  return browser.execute(
    (position: number) =>
      document
        .querySelector(`[data-file-index='${position}']`)
        ?.querySelectorAll("[data-fan-leaf]").length ?? -1,
    cardPosition,
  )
}

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
  await browser.waitUntil(
    async () => (await thumbFingerprint(pageNumber)) === fingerprint,
    { timeout: 15_000, timeoutMsg: `cell ${pageNumber} never showed the expected page` },
  )
}

async function paintedFingerprints(pageCount: number) {
  const fingerprints: number[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    await browser.waitUntil(
      async () => (await thumbFingerprint(pageNumber)) > 0,
      { timeout: 15_000, timeoutMsg: `cell ${pageNumber} never painted` },
    )
    fingerprints.push(await thumbFingerprint(pageNumber))
  }

  expect(new Set(fingerprints).size).toBe(pageCount)

  return fingerprints
}

/** Drags a file card into another card's gap with dispatched pointer events —
    the only press semantics WebKitGTK honours (the M3 lesson). */
function dragCardToGap(from: number, target: number, pastEnd = false) {
  return browser.execute(
    (f: number, t: number, end: boolean) => {
      const card = (position: number) =>
        document.querySelector(`[data-file-index='${position}']`)!
      const fromBox = card(f).getBoundingClientRect()
      const targetBox = card(t).getBoundingClientRect()
      const start = {
        x: fromBox.left + fromBox.width / 2,
        y: fromBox.top + fromBox.height / 2,
      }
      const dest = end
        ? { x: targetBox.right + 8, y: targetBox.top + targetBox.height / 2 }
        : { x: targetBox.left + 8, y: targetBox.top + targetBox.height / 2 }

      card(f).dispatchEvent(
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
        new PointerEvent("pointermove", { bubbles: true, clientX: dest.x, clientY: dest.y }),
      )
      document.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: dest.x, clientY: dest.y }),
      )
    },
    from,
    target,
    pastEnd,
  )
}

async function switchTo(viewLabel: string) {
  await $(`button[aria-label='${viewLabel}']`).click()
}

describe("TFolio multi-file merge", () => {
  beforeEach(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.setItem(keys.viewMode, "files")
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
  })

  it("merges dropped files into cards with the right page counts", async () => {
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70]))
    await browser.waitUntil(async () => (await cardCount()) === 1, {
      timeoutMsg: "the initial file card never appeared",
    })

    await mergeFromDisk("added.pdf", bandedPdf([110, 150, 190]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the merged file card never appeared",
    })

    // The initial 2-page file and the merged 3-page file, each on its own card.
    expect(await cardCaptions()).toEqual(["2 pages", "3 pages"])

    // A multi-page file fans; a single-page one does not.
    await mergeFromDisk("solo.pdf", bandedPdf([50]))
    await browser.waitUntil(async () => (await cardCount()) === 3, {
      timeoutMsg: "the single-page card never appeared",
    })
    expect(await fanLeaves(1)).toBeGreaterThan(0)
    expect(await fanLeaves(3)).toBe(0)
  })

  it("reorders whole files by dragging their cards, and undoes it", async () => {
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70]))
    await mergeFromDisk("added.pdf", bandedPdf([110, 150, 190]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the merge never landed",
    })

    // Read the page order from the thumbnail grid.
    await switchTo("Thumbnails")
    const [a1, a2, b1, , b3] = await paintedFingerprints(5)

    // Bring the second file (cards) in front of the first.
    await switchTo("Files")
    await dragCardToGap(2, 1)

    await switchTo("Thumbnails")
    // The 3-page file now leads: [b1, b2, b3, a1, a2].
    await waitForThumb(1, b1!)
    await waitForThumb(3, b3!)
    await waitForThumb(4, a1!)
    await waitForThumb(5, a2!)

    await $("button[aria-label='Undo']").click()
    await waitForThumb(1, a1!)
    await waitForThumb(3, b1!)
    await waitForThumb(5, b3!)
  })

  it("removes a whole file and undoes it", async () => {
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70]))
    await mergeFromDisk("added.pdf", bandedPdf([110, 150, 190]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the merge never landed",
    })

    await $("button[aria-label='Remove added.pdf']").click()
    await browser.waitUntil(async () => (await cardCount()) === 1, {
      timeoutMsg: "removing the file never dropped its card",
    })
    // Its three pages went with it: only the base's two remain.
    await switchTo("Thumbnails")
    await browser.waitUntil(async () => (await thumbCount()) === 2, {
      timeoutMsg: "the merged pages did not leave with the file",
    })

    await $("button[aria-label='Undo']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 5, {
      timeoutMsg: "undo never restored the removed file",
    })
  })

  it("pads files onto odd pages and clears the pads again", async () => {
    // base 2 pages, added 2 pages: added would start on page 3 (odd) — no pad
    // needed. Use a 3-page base so the second file starts even.
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70, 110]))
    await mergeFromDisk("added.pdf", bandedPdf([150, 190]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the merge never landed",
    })
    await switchTo("Thumbnails")
    await browser.waitUntil(async () => (await thumbCount()) === 5, {
      timeoutMsg: "the merge did not reach five pages",
    })

    // Turn on smart padding: one blank page appears before the second file.
    await $("button[aria-label='Odd-page file starts']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 6, {
      timeoutMsg: "the pad page never appeared",
    })
    // The inserted page is blank, and it sits at position 4 (before the file).
    await waitForThumb(4, 0)

    // Turn it back off: the pad goes.
    await $("button[aria-label='Odd-page file starts']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 5, {
      timeoutMsg: "the pad page never cleared",
    })
  })

  it("keeps smart padding on when the layout needs no pad yet", async () => {
    // base 2 + a 1-page file: the second file lands on page 3 (odd), so turning
    // the toggle on adds nothing right now — but the intent must persist.
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70]))
    await mergeFromDisk("one.pdf", bandedPdf([110]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the first merge never landed",
    })
    await switchTo("Thumbnails")
    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeoutMsg: "the first merge did not reach three pages",
    })

    const toggle = () => $("button[aria-label='Odd-page file starts']")

    await toggle().click()
    // Nothing to pad, so the page count holds — but the toggle reads as on.
    await expect(toggle()).toHaveAttribute("aria-pressed", "true")
    expect(await thumbCount()).toBe(3)

    // A later merge that *would* start on an even page now gets its pad, because
    // the intent was kept even though no pad had been needed.
    await switchTo("Files")
    await mergeFromDisk("two.pdf", bandedPdf([150, 190]))
    await switchTo("Thumbnails")
    // base[1,2] one[3] pad[4] two[5,6] — the reconcile added the pad.
    await browser.waitUntil(async () => (await thumbCount()) === 6, {
      timeoutMsg: "the enabled feature never padded the later merge",
    })
    await waitForThumb(4, 0)
  })

  it("re-pads after a grid edit pushes a file onto an even page", async () => {
    // base 2 + added 2: the added file opens on page 3 (odd), so smart padding
    // needs no blank yet. Turning it on records the intent.
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70]))
    await mergeFromDisk("added.pdf", bandedPdf([110, 150]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the merge never landed",
    })
    const toggle = () => $("button[aria-label='Odd-page file starts']")
    await toggle().click()
    await expect(toggle()).toHaveAttribute("aria-pressed", "true")

    // A page-level delete, not a file-level one, must still hold the odd-start
    // guarantee. Deleting a base page in the grid drops the added file onto page
    // 2 (even); the reconcile has to follow the grid edit and slip a blank in
    // front of it — leaving base[1] pad[2] added[3,4].
    await switchTo("Thumbnails")
    await paintedFingerprints(4)
    await $("button[aria-label='Delete page 1']").click()
    // A blank at position 2 exists only in the final padded layout: the 3-page
    // state the delete leaves has a real page there, so this waits past it.
    await waitForThumb(2, 0)
    await browser.waitUntil(async () => (await thumbCount()) === 4, {
      timeoutMsg: "the reconcile did not restore the padded page count",
    })
  })

  it("disables save on a merged document but still exports", async () => {
    await openPdfFromDisk("base.pdf", bandedPdf([30, 70]))
    await mergeFromDisk("added.pdf", bandedPdf([110, 150]))
    await browser.waitUntil(async () => (await cardCount()) === 2, {
      timeoutMsg: "the merge never landed",
    })

    // A merged document can only be exported as a copy, never saved over source.
    await expect($("button[aria-label='Save']")).toBeDisabled()
    await expect($("button[aria-label='Save options']")).toBeEnabled()
  })
})
