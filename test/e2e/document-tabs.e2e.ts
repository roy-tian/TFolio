import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  dropZoneButton,
  emitDrag,
  gapPoint,
  minimalPdf,
  openFileButton,
  openPathViaDialog,
  openPdfFromDisk,
  recentFilesStore,
  refreshApp,
  seedSettings,
} from "./helpers"

function writePdf(name: string, pages: number) {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-tabs-"))
  const filePath = path.join(directory, name)
  writeFileSync(filePath, minimalPdf(pages))
  return filePath
}

function tabButtons() {
  return $$("button[role='tab']")
}

function tabButton(name: string) {
  return $(`//button[@role='tab'][normalize-space()='${name}']`)
}

function tabNames() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("[data-document-tab]"), (tab) =>
      tab.querySelector("button[role='tab']")?.textContent?.trim() ?? "",
    ),
  )
}

/**
 * Drags the document tab at `from` onto `across` (0–1) of the tab at `to`,
 * 0-based among the documents — pointer events, the only press semantics a
 * test has under WebKitGTK. Held drags stash their release point: the strip
 * translates under the pointer mid-gesture, so a later release must restate
 * the coordinates the gesture actually rests at.
 */
function dragTab(from: number, to: number, across: number, release = true) {
  return browser.execute(
    (f: number, t: number, span: number, shouldRelease: boolean) => {
      const tab = (index: number) =>
        document.querySelector(`[data-list-index='${index}']`)!
      const fromBox = tab(f).getBoundingClientRect()
      const toBox = tab(t).getBoundingClientRect()
      // Over the tab's title, clear of its close button.
      const start = {
        x: fromBox.left + fromBox.width * 0.3,
        y: fromBox.top + fromBox.height / 2,
      }
      const dest = {
        x: toBox.left + toBox.width * span,
        y: toBox.top + toBox.height / 2,
      }

      tab(f).dispatchEvent(
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

      if (shouldRelease) {
        document.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            clientX: dest.x,
            clientY: dest.y,
          }),
        )
      } else {
        ;(window as unknown as { __tabDragDest?: { x: number; y: number } }).__tabDragDest = dest
      }
    },
    from,
    to,
    across,
    release,
  )
}

function releaseHeldTab() {
  return browser.execute(() => {
    const dest = (window as unknown as { __tabDragDest: { x: number; y: number } })
      .__tabDragDest

    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: dest.x,
        clientY: dest.y,
      }),
    )
  })
}

function recentEntry(filePath: string) {
  return $(
    `//button[@data-slot='recent-file'][contains(., '${path.basename(filePath)}')]`,
  )
}

function activeScrollTop() {
  return browser.execute(() => {
    const viewer = document.querySelector<HTMLElement>(
      "[data-document-session][data-active='true'] main",
    )

    return viewer ? Math.round(viewer.scrollTop) : -1
  })
}

async function settledScrollTop() {
  let previous = -1

  await browser.waitUntil(
    async () => {
      const current = await activeScrollTop()
      const settled = current > 0 && current === previous
      previous = current

      return settled
    },
    { interval: 200, timeoutMsg: "the viewer never settled at an offset" },
  )

  return previous
}

async function resetWorkspace() {
  await refreshApp()
  // The view mode persists, so leave it unset to start from the single view.
  await seedSettings({ ui: { language: "en" } })
  await refreshApp()
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
    // The offset as well as the page: a hidden tab measures 0x0, and laying its
    // pages out against that once left it clamped to the top of the document.
    const readingOffset = await settledScrollTop()

    const secondPath = writePdf("second.pdf", 1)
    await openPathViaDialog(secondPath)
    await tabButton("second.pdf").waitForExist()
    await expect(tabButtons()).toBeElementsArrayOfSize(3)
    await expect(tabButton("second.pdf")).toHaveAttribute(
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

    await tabButton("first.pdf").click()
    await expect(
      $("[data-active='true'] input[aria-label='Page number']"),
    ).toHaveValue("2")
    await browser.waitUntil(
      async () => (await activeScrollTop()) === readingOffset,
      { timeoutMsg: "the tab came back to a different reading position" },
    )

    // An exact duplicate activates its existing tab instead of opening a third.
    await tabButton("second.pdf").click()
    await openPathViaDialog(firstPath)
    await expect(tabButtons()).toBeElementsArrayOfSize(3)
    await expect(tabButton("first.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await $("button[aria-label='Close second.pdf']").click()
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
    await expect(tabButton("first.pdf")).toBeFocused()

    await openPathViaDialog(secondPath)
    await tabButton("first.pdf").click()
    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Delete page 1']").waitForExist()
    await $("button[aria-label='Delete page 1']").click()
    await browser.waitUntil(
      async () =>
        (await $("[data-active='true'] [data-slot='page-status']").getAttribute("aria-label")) ===
        "Page 1 of 2",
      { timeoutMsg: "the page deletion never made the tab dirty" },
    )

    await tabButton("second.pdf").click()
    await expect(
      $("[data-active='true'] button[aria-label^='Undo']"),
    ).toBeDisabled()
    await tabButton("first.pdf").click()
    await expect(
      $("[data-active='true'] button[aria-label^='Undo']"),
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

    const entry = recentEntry(filePath)
    await entry.waitForDisplayed()
    await expect(entry).toHaveText(/recent\.pdf/)

    await entry.click()
    await tabButton("recent.pdf").waitForExist()
    await expect($("[data-page-number='1']")).toBeDisplayed()

    // A file already open is not opened twice: its recent entry just goes back
    // to the tab it is in.
    await $("#workspace-tab-home").click()
    await entry.click()
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
    await expect(tabButton("recent.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("removes one entry from the home tab's recent list", async () => {
    // Each open waits for the one before: the strip's open button is disabled
    // while an open is in flight, so a second click that lands early is lost.
    const removedPath = await openPdfFromDisk("removed-recent.pdf", minimalPdf(1))
    await expect(tabButton("removed-recent.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )
    await openPdfFromDisk("kept-recent.pdf", minimalPdf(1))
    await expect(tabButton("kept-recent.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    await $("#workspace-tab-home").click()
    const removedEntry = recentEntry(removedPath)
    await removedEntry.waitForDisplayed()

    // The remove key is hover-revealed and, hidden, holds no pointer events,
    // and the WebDriver can flip CSS :hover for neither, so the click is
    // dispatched in-page against the row's own button.
    await browser.execute((name: string) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-slot='recent-file']"),
      ).find((entry) => entry.textContent?.includes(name))
      const remove = row
        ?.closest("li")
        ?.querySelector<HTMLElement>("[data-slot='remove-recent-file']")

      remove?.click()
    }, "removed-recent.pdf")

    await browser.waitUntil(async () => !(await removedEntry.isExisting()), {
      timeout: 15_000,
      timeoutMsg: "the removed entry never left the list",
    })

    // The store, not the page, is what the next run's home tab reads: the
    // removal must reach it while its neighbour survives.
    const store = recentFilesStore()
    await browser.waitUntil(
      () => {
        if (!existsSync(store)) {
          return false
        }

        const written = readFileSync(store, "utf8")

        return !written.includes(removedPath) && written.includes("kept-recent.pdf")
      },
      { timeout: 15_000, timeoutMsg: "the removal never reached the store" },
    )
  })

  it("restores a recent file's view, zoom, and reading position", async () => {
    const filePath = await openPdfFromDisk("view-kept.pdf", minimalPdf(9))
    await $("[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Book']").click()
    await expect($("button[aria-label='Book']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    // Land on a known custom zoom: down to the floor, then three rungs back to
    // actual size (50%, 75%, 100%).
    const zoomOut = () => $("button[aria-label='Zoom out']")
    while (await zoomOut().isEnabled()) {
      await zoomOut().click()
    }
    for (let rung = 0; rung < 3; rung += 1) {
      await $("button[aria-label='Zoom in']").click()
    }
    await expect(
      $("[data-slot='button-group'][aria-label^='Zoom ']"),
    ).toHaveAttribute("aria-label", "Zoom 100%")

    const pageInput = $("[data-active='true'] input[aria-label='Page number']")
    await pageInput.setValue("5")
    await browser.keys("Enter")
    await settledScrollTop()

    // Keep a point inside the page, not merely its page number, so restoring a
    // raw "page 5" jump would not satisfy the offset assertion below.
    await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      viewer.scrollTop += 80
    })
    const readingOffset = await activeScrollTop()
    await expect(pageInput).toHaveValue("5")

    await $("button[aria-label='Close view-kept.pdf']").click()
    await dropZoneButton().waitForDisplayed()

    // The global default now disagrees with this file, proving that Book comes
    // from the recent entry rather than the ordinary view-mode preference.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForDisplayed()

    const entry = recentEntry(filePath)
    await entry.click()
    await tabButton("view-kept.pdf").waitForExist()
    await expect($("button[aria-label='Book']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(
      $("[data-slot='button-group'][aria-label^='Zoom ']"),
    ).toHaveAttribute("aria-label", "Zoom 100%")
    await expect(
      $("[data-active='true'] input[aria-label='Page number']"),
    ).toHaveValue("5")
    await browser.waitUntil(
      async () => Math.abs((await activeScrollTop()) - readingOffset) <= 2,
      { timeoutMsg: "the recent file opened at a different reading position" },
    )
  })

  it("reorders tabs by dragging along the strip", async () => {
    await openPdfFromDisk("drag-a.pdf", minimalPdf(1))
    await openPdfFromDisk("drag-b.pdf", minimalPdf(1))
    await openPdfFromDisk("drag-c.pdf", minimalPdf(1))
    await expect(tabButtons()).toBeElementsArrayOfSize(4)

    // Held over the first tab, the dragged one rides the pointer as a ghost
    // while the strip itself still shows the order it started with.
    await dragTab(2, 0, 0.25, false)
    await expect(await tabNames()).toEqual([
      "drag-a.pdf",
      "drag-b.pdf",
      "drag-c.pdf",
    ])
    await browser.waitUntil(
      async () => (await $("[data-slot='tab-drag-ghost']").isExisting()),
      { timeoutMsg: "the dragged tab never appeared as a ghost" },
    )

    await releaseHeldTab()
    await browser.waitUntil(
      async () =>
        (await tabNames()).join() === "drag-c.pdf,drag-a.pdf,drag-b.pdf",
      { timeoutMsg: "the dragged tab never took the front place" },
    )
    // Home still leads the strip, ahead of the reordered documents.
    await expect((await tabButtons())[0]).toHaveAttribute(
      "id",
      "workspace-tab-home",
    )
    // Dragging is not activating: the tab that led the workspace still does.
    await expect(tabButton("drag-c.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    // The click a real press makes still activates, whatever dragged before it.
    await tabButton("drag-b.pdf").click()
    await expect(tabButton("drag-b.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )

    // And the other way: front to back.
    await dragTab(0, 2, 0.75)
    await browser.waitUntil(
      async () =>
        (await tabNames()).join() === "drag-a.pdf,drag-b.pdf,drag-c.pdf",
      { timeoutMsg: "the dragged tab never took the back place" },
    )
    await expect(tabButton("drag-b.pdf")).toHaveAttribute(
      "aria-selected",
      "true",
    )
  })

  it("keeps a PDF dropped on the grid inside the current tab", async () => {
    await openPdfFromDisk("base.pdf", minimalPdf(2))
    await $("button[aria-label='Thumbnails']").click()
    await $("button[data-page-number='1']").waitForDisplayed()

    const addedPath = writePdf("inserted.pdf", 2)
    const point = await gapPoint(1)

    await emitDrag("drag-over", point, [addedPath])
    await emitDrag("drag-drop", point, [addedPath])

    await browser.waitUntil(
      async () => (await $$("button[data-page-number]").length) === 4,
      { timeoutMsg: "the dropped PDF's pages never joined the document" },
    )
    // The pages joined this document rather than opening tabs of their own —
    // anywhere but the grid, the same drop would.
    await expect(tabButtons()).toBeElementsArrayOfSize(2)
    await expect($("button[aria-label='Close base.pdf']")).toBeDisplayed()
  })
})
