import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { PdfDocumentInfo } from "../../src/lib/pdf"

import {
  appMenuItem,
  clickAppMenuItem,
  closeAppMenu,
  dropZoneButton,
  highlightTheText,
  openPdfFromDisk,
  pageInk,
  pointMultiPickerAt,
  pointSaveAsAt,
  refreshApp,
  renderedPage,
  seedSettings,
  signedPdf,
  textPdf,
  tooltipOn,
  writeScratchPdf,
} from "./helpers"

const tabBadge = "[data-document-tab] [data-signatures]"
const workspace = "[data-organize-workspace]"

/** Answers the organize save dialog with `destination` and runs the real
    assembly and write behind it. */
async function pointOrganizeSaveAt(destination: string) {
  await browser.execute((target: string) => {
    const seam = window as unknown as Window & {
      __tfolioE2E?: E2eOverrides
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: unknown) => Promise<unknown>
      }
    }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      saveAssembledPdf: ({ onProgress, plan }) =>
        seam.__TAURI_INTERNALS__.invoke("save_assembled_pdf_to", {
          onProgress,
          path: target,
          plan,
        }) as Promise<PdfDocumentInfo | null>,
    }
  }, destination)
}

async function organizeWith(paths: string[]) {
  await $("button[aria-label='Organize pages']").click()
  await $(`${workspace} [data-slot='organize-empty-add']`).waitForDisplayed()
  await pointMultiPickerAt(paths)
  await $(`${workspace} [data-slot='organize-empty-add']`).click()
  await browser.waitUntil(
    async () =>
      (await $$(`${workspace} [data-slot='organize-file']`).getElements()).length ===
      paths.length,
    { timeout: 30_000, timeoutMsg: "the picked files never reached the list" },
  )
}

function tabNamed(name: string) {
  return $(`//button[@role='tab'][normalize-space()='${name}']`)
}

describe("TFolio signed documents", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("marks a signed file's tab and never writes over the file", async () => {
    const sourcePath = await openPdfFromDisk("signed.pdf", signedPdf())
    const original = readFileSync(sourcePath)
    await renderedPage()

    await expect($(tabBadge)).toBeDisplayed()
    expect(await tooltipOn(tabBadge)).toBe("Contains 1 digital signature")

    // Unchanged, the copy is the signed file itself, and the tab stays on it.
    const copyPath = path.join(path.dirname(sourcePath), "copy.pdf")
    await pointSaveAsAt(copyPath)
    await clickAppMenuItem("save-as")
    await browser.waitUntil(() => Promise.resolve(existsSync(copyPath)), {
      timeout: 15_000,
      timeoutMsg: "Save As never wrote the copy",
    })
    expect(readFileSync(copyPath).equals(original)).toBe(true)
    await expect(tabNamed("signed.pdf")).toHaveAttribute("aria-selected", "true")

    const clean = await pageInk()
    await highlightTheText()
    await browser.waitUntil(async () => (await pageInk()) > clean, {
      timeout: 15_000,
      timeoutMsg: "the highlight never reached the page",
    })

    const save = await appMenuItem("save")
    expect(await save.getAttribute("data-disabled")).not.toBe(null)
    expect(await tooltipOn("[data-action='save']")).toContain(
      "intact digital signatures",
    )
    await closeAppMenu(save)

    await browser.keys(["Control", "s"])
    await $("[data-notice='saveSignedOnly']").waitForDisplayed()
    expect(readFileSync(sourcePath).equals(original)).toBe(true)

    // Edited, the copy is PDFium's rewrite: the tab moves to it and may save there.
    const editedPath = path.join(path.dirname(sourcePath), "edited.pdf")
    await pointSaveAsAt(editedPath)
    await clickAppMenuItem("save-as")
    await expect(tabNamed("edited.pdf")).toHaveAttribute("aria-selected", "true")
    await expect($(tabBadge)).not.toBeExisting()
    expect(existsSync(editedPath)).toBe(true)
    expect(readFileSync(sourcePath).equals(original)).toBe(true)
  })

  it("brings a background signed tab forward from its badge", async () => {
    await openPdfFromDisk("signed.pdf", signedPdf())
    await renderedPage()
    await openPdfFromDisk("plain.pdf", textPdf())
    await expect(tabNamed("plain.pdf")).toHaveAttribute("aria-selected", "true")

    await $(tabBadge).click()
    await expect(tabNamed("signed.pdf")).toHaveAttribute("aria-selected", "true")
  })

  it("marks a signed file on the organize list and never saves over it", async () => {
    const signed = writeScratchPdf("signed.pdf", signedPdf())
    const original = readFileSync(signed)
    const plain = writeScratchPdf("plain.pdf", textPdf())

    await organizeWith([signed, plain])

    const badges = await browser.execute((scope: string) =>
      Array.from(document.querySelectorAll(`${scope} [data-slot='organize-file']`)).map(
        (row) => row.querySelector("[data-signatures]")?.getAttribute("data-signatures") ?? null,
      ),
    workspace)
    expect(badges).toEqual(["1", null])

    // The new PDF is PDFium's rewrite: over the signed source it would break
    // every signature, so the write is refused before it lands.
    await pointOrganizeSaveAt(signed)
    await $(`${workspace} [data-slot='organize-save']`).click()
    await $("[data-notice='exportSigned']").waitForDisplayed({ timeout: 30_000 })
    expect(readFileSync(signed).equals(original)).toBe(true)
  })
})
