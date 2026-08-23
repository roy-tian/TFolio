import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"
import {
  dropZoneButton,
  minimalPdf,
  openFileButton,
  openPathViaDialog,
  openPdfFromDisk,
  pointPickerAt,
} from "./helpers"

function writePdf(name: string, pages: number) {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-tabs-"))
  const filePath = path.join(directory, name)
  writeFileSync(filePath, minimalPdf(pages))
  return filePath
}

/** Every tab in the strip, the home tab included — it leads the list. */
function tabButtons() {
  return $$("button[role='tab']")
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
  await openFileButton().waitForExist({ timeout: 30_000 })
}

describe("independent document tabs", () => {
  beforeEach(resetWorkspace)

  it("closes the only clean document back to the home tab", async () => {
    await openPdfFromDisk("only.pdf", minimalPdf())
    const close = $("button[aria-label='Close only.pdf']")

    await close.waitForDisplayed()
    await close.click()
    await dropZoneButton().waitForDisplayed()
    await expect(tabButtons()).toBeElementsArrayOfSize(1)
    await expect($("#workspace-tab-home")).toBeFocused()
    await expect($("#workspace-tab-home")).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("keeps the strip through an empty workspace and preserves per-tab state", async () => {
    const firstPath = await openPdfFromDisk("first.pdf", minimalPdf(3))
    await $("[data-page-number='1']").waitForDisplayed()
    await expect(tabButtons()).toBeElementsArrayOfSize(2)

    const pageInput = $("[data-active='true'] input[aria-label='Page number']")
    await pageInput.setValue("2")
    await browser.keys("Enter")
    await expect(pageInput).toHaveValue("2")

    const secondPath = writePdf("second.pdf", 1)
    await openPathViaDialog(secondPath)
    await $("button[role='tab'][title='second.pdf']").waitForExist()
    await expect(tabButtons()).toBeElementsArrayOfSize(3)
    await expect($("button[role='tab'][title='second.pdf']")).toHaveAttribute(
      "aria-controls",
      expect.stringMatching(/^workspace-panel-/),
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
    await openPathViaDialog(firstPath)
    await expect(tabButtons()).toBeElementsArrayOfSize(3)
    await expect($("button[role='tab'][title='first.pdf']")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await $("button[aria-label='Close second.pdf']").click()
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
    await expect($("button[role='tab'][title='first.pdf']")).toBeFocused()

    // Reopen a clean neighbour, dirty the first document, and verify both
    // branches of the tab-close guard.
    await openPathViaDialog(secondPath)
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
    await expect(tabButtons()).toBeElementsArrayOfSize(3)

    await $("button[aria-label='Close first.pdf']").click()
    await $("button=Discard and close tab").click()
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
  })

  it("reopens a closed document from the home tab's recent list", async () => {
    const filePath = await openPdfFromDisk("recent.pdf", minimalPdf(2))
    await $("[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Close recent.pdf']").click()
    await dropZoneButton().waitForDisplayed()

    const entry = $("[data-slot='recent-file'][title='" + filePath + "']")
    await entry.waitForDisplayed()
    await expect(entry).toHaveText(/recent\.pdf/)

    await entry.click()
    await $("button[role='tab'][title='recent.pdf']").waitForExist()
    await expect($("[data-page-number='1']")).toBeDisplayed()

    // A file already open is not opened twice: its recent entry just goes back
    // to the tab it is in.
    await $("#workspace-tab-home").click()
    await entry.click()
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
    await expect($("button[role='tab'][title='recent.pdf']")).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("keeps the Files-view add action as a merge into the current tab", async () => {
    await openPdfFromDisk("base.pdf", minimalPdf(2))
    await $("button[aria-label='Files']").click()
    await $("[data-slot='add-file']").waitForDisplayed()

    const addedPath = writePdf("merged.pdf", 2)
    await pointPickerAt(addedPath)
    await $("[data-slot='add-file']").click()

    await browser.waitUntil(
      async () => (await $$('[data-file-index]').length) === 2,
      { timeoutMsg: "the added PDF did not become a second file card" },
    )
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
    await expect($("button[aria-label='Close base.pdf']")).toBeDisplayed()
  })
})
