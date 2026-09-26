import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { PdfExportOutcome } from "../../src/lib/pdf"
import {
  appMenuItem,
  appMenuItemEnabled,
  clickAppMenuItem,
  closeAppMenu,
  dropZoneButton,
  openPathViaDialog,
  openPdfFromBytes,
  openPdfFromDisk,
  pageInk,
  refreshApp,
  renderedPage,
  seedSettings,
  textPdf,
  writeScratchPdf,
} from "./helpers"

/** Selects the page's one text run and lets go, the way the reader highlights:
    the press has to land on the text for the release to commit. */
async function highlightTheText() {
  // The tool stays on after a highlight, and a second press would turn it off.
  const tool = $("button[aria-label='Highlight text']")
  if ((await tool.getAttribute("aria-pressed")) !== "true") {
    await tool.click()
  }

  const selected = await browser.execute(() => {
    const span = document.querySelector(".pdf-text-layer span")

    if (!span) {
      return null
    }

    span.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))

    const range = document.createRange()
    range.selectNodeContents(span)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    return span.textContent
  })
  expect(selected).toContain("Highlight")

  await browser.execute(() => {
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
  })
}

/** Answers Save As's dialog with `destination` and runs the real write behind
    it, through the command the e2e build keeps for this. */
async function pointSaveAsAt(destination: string) {
  await browser.execute((target: string) => {
    const seam = window as unknown as Window & {
      __tfolioE2E?: E2eOverrides
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) => Promise<unknown>
      }
    }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      exportPdf: ({ documentId }) =>
        seam.__TAURI_INTERNALS__.invoke("export_pdf_to", {
          documentId,
          path: target,
        }) as Promise<PdfExportOutcome>,
    }
  }, destination)
}

/** Stands in for Save As's dialog, cancelling it after noting the name it
    was asked to suggest. */
async function recordSaveAsAsks() {
  await browser.execute(() => {
    const seam = window as Window & {
      __tfolioE2E?: E2eOverrides
      __saveAsAsks?: string[]
    }

    seam.__saveAsAsks = []
    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      exportPdf: async ({ suggestedName }) => {
        seam.__saveAsAsks!.push(suggestedName)
        return null
      },
    }
  })
}

function saveAsAsks() {
  return browser.execute(
    () => (window as Window & { __saveAsAsks?: string[] }).__saveAsAsks ?? [],
  )
}

function tabNamed(name: string) {
  return $(`//button[@role='tab'][normalize-space()='${name}']`)
}

describe("TFolio save", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("saves annotations back over the opened file", async () => {
    const filePath = await openPdfFromDisk("source.pdf", textPdf())
    const original = readFileSync(filePath)
    await renderedPage()

    // Nothing to save yet, so the menu's save item waits.
    expect(await appMenuItemEnabled("save")).toBe(false)

    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    // A mark on the page is a change on disk waiting to happen.
    expect(await appMenuItemEnabled("save")).toBe(true)
    await clickAppMenuItem("save")

    // The proof is the file: its bytes must actually change under the save.
    await browser.waitUntil(
      () => Promise.resolve(!readFileSync(filePath).equals(original)),
      { timeout: 15_000, timeoutMsg: "the save never rewrote the file" },
    )

    const saved = readFileSync(filePath)
    expect(saved.subarray(0, 5).toString("ascii")).toBe("%PDF-")
    expect(saved.length).toBeGreaterThan(original.length)

    await browser.waitUntil(
      async () => !(await appMenuItemEnabled("save")),
      { timeout: 15_000, timeoutMsg: "the save never marked the history clean" },
    )

    // Reloading first: the drop zone — the only way to the picker — exists only
    // without a document. Reopened, the page must carry more ink than clean.
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
    await openPathViaDialog(filePath)
    await renderedPage()
    expect(await pageInk()).toBeGreaterThan(clean)
  })

  it("disables save for a document opened from bytes, and leaves save as available", async () => {
    await openPdfFromBytes("bytes.pdf", textPdf())
    await renderedPage()

    expect(await appMenuItemEnabled("save")).toBe(false)

    // Even with a change to save, there is no file of its own to save over.
    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })
    expect(await appMenuItemEnabled("save")).toBe(false)

    // Saving a copy stays on offer — for this document it is the only way to
    // a file at all.
    const saveAs = await appMenuItem("save-as")
    await expect(saveAs).toHaveText(expect.stringContaining("Save as…"))
    expect(await saveAs.getAttribute("data-disabled")).toBe(null)
    await closeAppMenu(saveAs)

    // The bytes open's overrides must not outlive it: a picker-driven open
    // on this same page lands the real two-page file, not the stale payload.
    await openPathViaDialog(writeScratchPdf("after-bytes.pdf", textPdf(2)))
    await expect(
      $("//button[@role='tab'][normalize-space()='after-bytes.pdf']"),
    ).toHaveAttribute("aria-selected", "true")
    await expect(
      $("[data-active='true'] [data-slot='page-status']"),
    ).toHaveAttribute("aria-label", "Page 1 of 2")
  })

  it("asks where to save when the save key meets a document with no file", async () => {
    await openPdfFromBytes("save-key.pdf", textPdf())
    await renderedPage()
    await recordSaveAsAsks()

    await browser.keys(["Control", "s"])

    await browser.waitUntil(async () => (await saveAsAsks()).length > 0, {
      timeout: 15_000,
      timeoutMsg: "the save key did nothing on a document with no file",
    })
    expect(await saveAsAsks()).toEqual(["save-key.pdf"])
  })

  it("suggests the opened file's own name for Save As", async () => {
    await openPdfFromDisk("named-source.pdf", textPdf())
    await renderedPage()
    await recordSaveAsAsks()

    await clickAppMenuItem("save-as")

    await browser.waitUntil(async () => (await saveAsAsks()).length > 0, {
      timeout: 15_000,
      timeoutMsg: "Save As never asked for a destination",
    })
    expect(await saveAsAsks()).toEqual(["named-source.pdf"])
  })

  it("moves a document to the file Save As wrote, where the next save lands", async () => {
    const sourcePath = await openPdfFromDisk("source.pdf", textPdf())
    const original = readFileSync(sourcePath)
    const renamedPath = path.join(path.dirname(sourcePath), "renamed.pdf")
    await renderedPage()

    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    await pointSaveAsAt(renamedPath)
    await clickAppMenuItem("save-as")

    const renamedTab = tabNamed("renamed.pdf")
    await expect(renamedTab).toHaveAttribute("aria-selected", "true")
    await browser.waitUntil(
      async () =>
        !(await renamedTab.$("[aria-label='Unsaved changes']").isExisting()),
      { timeout: 15_000, timeoutMsg: "Save As never marked the history saved" },
    )
    expect(existsSync(renamedPath)).toBe(true)
    expect(await appMenuItemEnabled("save")).toBe(false)

    // A second highlight over the same run need not darken it further; the
    // save item coming alive is what proves the edit landed.
    const savedAs = readFileSync(renamedPath)
    await highlightTheText()
    await browser.waitUntil(() => appMenuItemEnabled("save"), {
      timeout: 15_000,
      timeoutMsg: "the second highlight never reached the history",
    })

    await browser.keys(["Control", "s"])
    await browser.waitUntil(
      () => Promise.resolve(!readFileSync(renamedPath).equals(savedAs)),
      { timeout: 15_000, timeoutMsg: "the save never reached the new file" },
    )
    await browser.waitUntil(
      async () => !(await appMenuItemEnabled("save")),
      { timeout: 15_000, timeoutMsg: "the save never marked the history clean" },
    )

    // Neither write may touch the file the document was opened from.
    expect(readFileSync(sourcePath).equals(original)).toBe(true)

    // The next Save As starts from the file the document is now bound to.
    await browser.execute(() => {
      const page = window as Window & {
        __saveAsName?: string
        __tfolioE2E?: E2eOverrides
      }

      page.__tfolioE2E = {
        ...page.__tfolioE2E,
        exportPdf: ({ suggestedName }) => {
          page.__saveAsName = suggestedName
          return Promise.resolve(null)
        },
      }
    })
    await clickAppMenuItem("save-as")
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (window as Window & { __saveAsName?: string }).__saveAsName ===
            "renamed.pdf",
        ),
      { timeoutMsg: "the next Save As did not suggest the bound file's name" },
    )
  })

  it("refuses Save As over a file another tab has open", async () => {
    const heldPath = await openPdfFromDisk("held.pdf", textPdf())
    const held = readFileSync(heldPath)
    await openPdfFromDisk("other.pdf", textPdf())
    await expect(tabNamed("other.pdf")).toHaveAttribute("aria-selected", "true")

    await pointSaveAsAt(heldPath)
    await clickAppMenuItem("save-as")

    await expect($("[data-notice='exportTargetOpen']")).toHaveText(
      "That file is open in another tab. Close it there first, or save under another name.",
    )
    await expect(tabNamed("other.pdf")).toHaveAttribute("aria-selected", "true")
    expect(readFileSync(heldPath).equals(held)).toBe(true)
  })
})
