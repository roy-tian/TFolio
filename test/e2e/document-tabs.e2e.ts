import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import type { E2eOverrides } from "../../src/lib/e2e"
import {
  dropZoneButton,
  minimalPdf,
  openPdfFromDisk,
  openPathViaToolbar,
} from "./helpers"

function writePdf(name: string, pages: number) {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-tabs-"))
  const filePath = path.join(directory, name)
  writeFileSync(filePath, minimalPdf(pages))
  return filePath
}

async function resetWorkspace() {
  await browser.refresh()
  await browser.execute(
    ({ languageKey, viewKey }: { languageKey: string; viewKey: string }) => {
      window.localStorage.setItem(languageKey, "en")
      window.localStorage.removeItem(viewKey)
    },
    { languageKey: languageStorageKey, viewKey: viewModeStorageKey },
  )
  await browser.refresh()
  await dropZoneButton().waitForExist({ timeout: 30_000 })
}

describe("independent document tabs", () => {
  beforeEach(resetWorkspace)

  it("closes the only clean document back to the empty workspace", async () => {
    await openPdfFromDisk("only.pdf", minimalPdf())
    const closeCurrent = $("[data-slot='close-current-document']")

    await closeCurrent.waitForDisplayed()
    await closeCurrent.click()
    await dropZoneButton().waitForDisplayed()
    await expect($("[role='tablist']")).not.toBeExisting()
    await expect($("[data-slot='titlebar-open-file']")).toBeFocused()
  })

  it("shows the strip at two documents and preserves per-tab view and undo state", async () => {
    const firstPath = await openPdfFromDisk("first.pdf", minimalPdf(3))
    await $("[data-page-number='1']").waitForDisplayed()
    await expect($("[role='tablist']")).not.toBeExisting()

    const pageInput = $("[data-active='true'] input[aria-label='Page number']")
    await pageInput.setValue("2")
    await browser.keys("Enter")
    await expect(pageInput).toHaveValue("2")

    const secondPath = writePdf("second.pdf", 1)
    await openPathViaToolbar(secondPath)
    await $("button[role='tab'][title='second.pdf']").waitForExist()
    await expect($$("button[role='tab']")).toBeElementsArrayOfSize(2)
    await expect($("button[role='tab'][title='second.pdf']")).toHaveAttribute(
      "aria-controls",
      expect.stringMatching(/^document-panel-/),
    )
    await expect($("button[aria-label='Close first.pdf']")).toHaveAttribute(
      "tabindex",
      "-1",
    )
    await expect(
      $("[data-active='true'] input[aria-label='Page number']"),
    ).toHaveValue("1")

    await $("button[role='tab'][title='first.pdf']").click()
    await expect(
      $("[data-active='true'] input[aria-label='Page number']"),
    ).toHaveValue("2")

    // An exact duplicate activates its existing tab instead of opening a third.
    await $("button[role='tab'][title='second.pdf']").click()
    await openPathViaToolbar(firstPath)
    await expect($$("button[role='tab']")).toBeElementsArrayOfSize(2)
    await expect($("button[role='tab'][title='first.pdf']")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await $("button[aria-label='Close second.pdf']").click()
    await expect($("[role='tablist']")).not.toBeExisting()
    await expect(
      $("[data-active='true'] [data-slot='session-open-file']"),
    ).toBeFocused()

    // Reopen a clean neighbour, dirty the first document, and verify both
    // branches of the tab-close guard.
    await openPathViaToolbar(secondPath)
    await $("button[role='tab'][title='first.pdf']").click()
    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Delete page 1']").waitForExist()
    await $("button[aria-label='Delete page 1']").click()
    await browser.waitUntil(
      async () =>
        (await $("[data-active='true'] [data-slot='page-status']").getAttribute("aria-label")) ===
        "Page 1 of 2",
      { timeoutMsg: "the page deletion never made the tab dirty" },
    )

    await $("button[role='tab'][title='second.pdf']").click()
    await expect(
      $("[data-active='true'] button[aria-label='Undo']"),
    ).toBeDisabled()
    await $("button[role='tab'][title='first.pdf']").click()
    await expect(
      $("[data-active='true'] button[aria-label='Undo']"),
    ).toBeEnabled()

    await $("button[aria-label='Close first.pdf']").click()
    await expect($("[role='alertdialog']")).toBeDisplayed()
    await $("button=Keep editing").click()
    await expect($$("button[role='tab']")).toBeElementsArrayOfSize(2)

    await $("button[aria-label='Close first.pdf']").click()
    await $("button=Discard and close tab").click()
    await expect($("[role='tablist']")).not.toBeExisting()
  })

  it("keeps the Files-view add action as a merge into the current tab", async () => {
    await openPdfFromDisk("base.pdf", minimalPdf(2))
    await $("button[aria-label='Files']").click()
    await $("[data-slot='add-file']").waitForDisplayed()

    const addedPath = writePdf("merged.pdf", 2)
    await browser.execute((mockPath: string) => {
      const seam = window as Window & { __tfolioE2E?: E2eOverrides }
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        pickPdfPath: () => Promise.resolve(mockPath),
      }
    }, addedPath)
    await $("[data-slot='add-file']").click()

    await browser.waitUntil(
      async () => (await $$('[data-file-index]').length) === 2,
      { timeoutMsg: "the added PDF did not become a second file card" },
    )
    await expect($("[role='tablist']")).not.toBeExisting()
    await expect($("[data-slot='close-current-document']")).toBeDisplayed()
  })
})
