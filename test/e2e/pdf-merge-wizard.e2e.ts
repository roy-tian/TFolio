import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import type { E2eOverrides } from "../../src/lib/e2e"
import {
  bandedPdf,
  clickAppMenuItem,
  dropZoneButton,
  emitDrag,
  minimalPdf,
  pointMultiPickerAt,
  refreshApp,
  seedSettings,
  writeScratchPdf,
} from "./helpers"

function outlinedPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n",
    "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
    "6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n",
    "7 0 obj\n<< /Title (Second half) /Parent 6 0 R /Dest [4 0 R /XYZ null null null] >>\nendobj\n",
  ]
  const chunks = ["%PDF-1.4\n"]
  const offsets: number[] = []
  let byteLength = Buffer.byteLength(chunks[0]!, "ascii")

  for (const object of objects) {
    offsets.push(byteLength)
    chunks.push(object)
    byteLength += Buffer.byteLength(object, "ascii")
  }

  const xrefOffset = byteLength
  chunks.push(`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n")

  for (const offset of offsets) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }

  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  )

  return Buffer.from(chunks.join(""), "ascii")
}

async function openWizardWith(paths: string[]) {
  await pointMultiPickerAt(paths)
  await $("[data-slot='merge-wizard-button']").click()
  await $("[data-testid='merge-wizard']").waitForDisplayed({ timeout: 15_000 })
}

async function addPickedFiles(expectedRows: number) {
  await $("[data-testid='merge-wizard-add']").click()
  await browser.waitUntil(
    async () => (await $$("[data-slot='merge-file']").getElements()).length === expectedRows,
    { timeout: 15_000, timeoutMsg: "the picked files never reached the list" },
  )
}

async function setPageLayers(pageNumbers: boolean, watermark: boolean) {
  for (const [id, checked] of [
    ["page-numbers", pageNumbers],
    ["watermark", watermark],
  ] as const) {
    const checkbox = $(`[data-testid='merge-wizard-${id}']`)
    if ((await checkbox.getAttribute("aria-checked")) !== String(checked)) {
      await checkbox.click()
    }
  }
}

function nextStep() {
  return $("[data-testid='merge-wizard-next']").click()
}

function trailSteps() {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll("[aria-label='Merge steps'] li"),
      (step) => step.textContent?.replace(/^\d+/, "").trim() ?? "",
    ),
  )
}

/**
 * Drags the row at `from` to rest above or below the row at `to` (0-based) —
 * pointer events, the only press semantics a test has under WebKitGTK.
 */
function dragRow(
  from: number,
  to: number,
  edge: "above" | "below",
  release = true,
) {
  return browser.execute(
    (f: number, t: number, low: boolean, shouldRelease: boolean) => {
      const row = (index: number) =>
        document.querySelector(`[data-list-index='${index}']`)!
      const fromBox = row(f).getBoundingClientRect()
      const targetBox = row(t).getBoundingClientRect()
      // Left of the row's own buttons, which are pressed rather than dragged.
      const start = {
        x: fromBox.left + 40,
        y: fromBox.top + fromBox.height / 2,
      }
      const dest = {
        x: targetBox.left + 40,
        y: low ? targetBox.bottom - 2 : targetBox.top + 2,
      }

      row(f).dispatchEvent(
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
      }
    },
    from,
    to,
    edge === "below",
    release,
  )
}

function releaseRow() {
  return browser.execute(() => {
    const ghost = document.querySelector<HTMLElement>(
      "[data-slot='merge-file-drag-ghost']",
    )!
    const box = ghost.getBoundingClientRect()

    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: box.left + 40,
        clientY: box.top + box.height / 2,
      }),
    )
  })
}

function listedNames() {
  return browser.execute(() =>
    [...document.querySelectorAll("[data-slot='merge-file']")].map(
      (row) =>
        row.querySelector("[data-slot='merge-file-name']")?.textContent?.trim() ??
        "",
    ),
  )
}

function thumbCount() {
  return browser.execute(
    () => document.querySelectorAll("button[data-page-number]").length,
  )
}

describe("merge wizard", () => {
  beforeEach(async () => {
    // The merged document opens on the grid of its own accord; pinning the
    // stored preference to single view is what proves it.
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("merges the listed files into a new document, in the order shown", async () => {
    const first = writeScratchPdf("first.pdf", bandedPdf(2))
    const second = writeScratchPdf("second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    // Two files are the least a merge takes, so the button is dead until then.
    await expect($("[data-testid='merge-wizard-next']")).toBeDisabled()

    await addPickedFiles(2)
    await setPageLayers(false, false)
    await expect($("[data-testid='merge-wizard-total']")).toHaveText(
      expect.stringContaining("3"),
    )
    await expect($("[data-testid='merge-wizard-next']")).toBeEnabled()

    await $("[data-testid='merge-wizard-bookmarks']").click()
    await $("[data-testid='merge-wizard-merge']").click()

    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeout: 30_000,
      timeoutMsg: "the merged document never opened on its thumbnail grid",
    })
    // The reader's stored view is single; a merge opens on the grid regardless,
    // which is where the whole result can be looked over at once.
    await expect($("[data-slot='merge-wizard-button']")).toBeDisplayed()

    const mergedTab = $("button[role='tab'][aria-selected='true']")
    await expect(mergedTab).toHaveText(expect.stringContaining("Merged.pdf"))
    await expect(
      mergedTab.$("[aria-label='Unsaved changes']"),
    ).toBeDisplayed()

    // The result exists only in memory until Save As gives it a path, so
    // closing it must take the same unsaved-work route as an edited document.
    await $("button[aria-label='Close Merged.pdf']").click()
    await expect($("[role='alertdialog']")).toBeDisplayed()
    await $("button=Keep editing").click()

    // WebDriver cannot answer the native dialog; the e2e-only seam records the
    // suggestion and stands in for a successful first save.
    await browser.execute(() => {
      const page = window as Window & {
        __mergeExportName?: string
        __tfolioE2E?: E2eOverrides
      }

      page.__tfolioE2E = {
        ...page.__tfolioE2E,
        exportPdf: (args) => {
          page.__mergeExportName = args.suggestedName
          return Promise.resolve({
            path: "/tmp/Merged.pdf",
            savedToSource: true,
          })
        },
      }
    })
    await clickAppMenuItem("save-as")
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (window as Window & { __mergeExportName?: string })
              .__mergeExportName === "Merged.pdf",
        ),
      { timeoutMsg: "Save As did not receive the merged document name" },
    )
    await browser.waitUntil(
      async () =>
        !(await mergedTab.$("[aria-label='Unsaved changes']").isExisting()),
      { timeoutMsg: "the first save never marked the merged document saved" },
    )
  })

  it("adds desktop drops from a prompt contained by the first step", async () => {
    const first = writeScratchPdf("dropped-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("dropped-second.pdf", minimalPdf(2))

    await openWizardWith([])
    const point = await browser.execute(() => {
      const box = document
        .querySelector("[data-testid='merge-wizard']")!
        .getBoundingClientRect()

      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })

    await emitDrag("drag-over", point, [first, second])

    const wizard = $("[data-testid='merge-wizard']")
    await expect(
      wizard.$("[data-testid='merge-wizard-file-drop']"),
    ).toBeDisplayed()
    await expect($("[data-testid='workspace-file-drop']")).not.toExist()

    await emitDrag("drag-drop", point, [first, second])
    await browser.waitUntil(
      async () => (await $$("[data-slot='merge-file']").getElements()).length === 2,
      { timeout: 15_000, timeoutMsg: "the dropped files never reached the list" },
    )
    expect(await listedNames()).toEqual([
      "dropped-first.pdf",
      "dropped-second.pdf",
    ])
    await expect(
      wizard.$("[data-testid='merge-wizard-file-drop']"),
    ).not.toExist()
  })

  it("shows determinate progress while the final merge is pending", async () => {
    const first = writeScratchPdf("progress-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("progress-second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await setPageLayers(false, false)
    await nextStep()

    // Holds the operation open to observe both states; the real backend's
    // progress sequence is the engine test's, without a timing race here.
    await browser.execute(() => {
      const seam = window as unknown as {
        __tfolioE2E?: Record<string, unknown>
      }

      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        mergePdfFiles: (
          _plan: unknown,
          onProgress: (progress: { completed: number; total: number }) => void,
        ) =>
          new Promise((_resolve, reject) => {
            window.setTimeout(
              () => onProgress({ completed: 2, total: 5 }),
              300,
            )
            window.setTimeout(
              () => reject(new Error("expected progress-test failure")),
              900,
            )
          }),
      }
    })

    await $("[data-testid='merge-wizard-merge']").click()

    const progress = $("[data-testid='merge-wizard-progress']")
    await progress.waitForDisplayed({ timeout: 15_000 })
    await browser.waitUntil(
      async () => (await progress.getAttribute("aria-valuenow")) === "40",
      { timeout: 15_000, timeoutMsg: "the merge progress never advanced" },
    )
    await expect(progress).toHaveText(expect.stringContaining("40%"))

    await progress.waitForDisplayed({ reverse: true, timeout: 15_000 })
    await expect($("[role='alert']")).toHaveText(
      expect.stringContaining("could not be merged"),
    )
  })

  it("keeps final progress open while requested page layers are applied", async () => {
    const first = writeScratchPdf("layer-progress-first.pdf", minimalPdf(100))
    const second = writeScratchPdf("layer-progress-second.pdf", minimalPdf(100))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await $("[data-testid='merge-wizard-bookmarks']").click()
    await nextStep()
    await nextStep()
    await $("[data-testid='merge-wizard-merge']").click()

    const progress = $("[data-testid='merge-wizard-progress']")
    await progress.waitForDisplayed({ timeout: 15_000 })
    await browser.waitUntil(
      async () => (await progress.getText()).includes("Adding page numbers"),
      { timeout: 60_000, timeoutMsg: "page-number progress never followed the merge" },
    )
    expect(Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(
      33,
    )
    await browser.waitUntil(
      async () => (await progress.getText()).includes("Adding watermark"),
      { timeout: 60_000, timeoutMsg: "watermark progress never followed page numbers" },
    )
    expect(Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(
      67,
    )

    await progress.waitForDisplayed({ reverse: true, timeout: 60_000 })
    await browser.waitUntil(async () => (await thumbCount()) === 200, {
      timeout: 30_000,
      timeoutMsg: "the fully prepared merged document never opened",
    })
  })

  it("stops the run from its footer, keeping what the merge already made", async () => {
    const first = writeScratchPdf("stop-first.pdf", minimalPdf(200))
    const second = writeScratchPdf("stop-second.pdf", minimalPdf(200))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await $("[data-testid='merge-wizard-bookmarks']").click()
    await setPageLayers(true, false)
    await nextStep()
    await $("[data-testid='merge-wizard-merge']").click()

    // Stopped inside the page-number phase — 400 pages of it, which is where a
    // run like this spends its time and where the reader gives up.
    const progress = $("[data-testid='merge-wizard-progress']")
    await progress.waitForDisplayed({ timeout: 15_000 })
    await browser.waitUntil(
      async () => (await progress.getText()).includes("Adding page numbers"),
      { timeout: 60_000, timeoutMsg: "page-number progress never followed the merge" },
    )
    await $("[data-testid='merge-wizard-stop']").click()

    // The merge itself had already landed, so its document opens — with none of
    // the numbering the reader walked out of.
    await $("[data-testid='merge-wizard']").waitForDisplayed({
      reverse: true,
      timeout: 60_000,
    })
    await browser.waitUntil(async () => (await thumbCount()) === 400, {
      timeout: 60_000,
      timeoutMsg: "the merged document never opened",
    })

    await $("button[aria-label='Page numbers']").click()
    await $("[data-testid='page-numbers-dialog']").waitForDisplayed({
      timeout: 15_000,
    })
    await expect(
      $("//button[normalize-space()='Remove page numbers']"),
    ).not.toBeExisting()
  })

  it("pads the files onto odd starts when asked", async () => {
    const first = writeScratchPdf("odd.pdf", minimalPdf(1))
    const second = writeScratchPdf("also-odd.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await setPageLayers(false, false)
    await $("[data-testid='merge-wizard-padding']").click()

    // One blank before the second file, which would otherwise open on page 2.
    await expect($("[data-testid='merge-wizard-total']")).toHaveText(
      expect.stringContaining("3"),
    )

    await $("[data-testid='merge-wizard-bookmarks']").click()
    await $("[data-testid='merge-wizard-merge']").click()

    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeout: 30_000,
      timeoutMsg: "the blank page never joined the merged document",
    })
  })

  it("hands the A4 option to the merge it starts", async () => {
    const first = writeScratchPdf("a4-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("a4-second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await setPageLayers(false, false)

    // What the option costs is said only once it has been chosen.
    const warning = $("[data-testid='merge-wizard-a4-warning']")
    await expect(warning).not.toBeExisting()

    await $("[data-testid='merge-wizard-a4']").click()
    await expect(warning).toHaveText(
      expect.stringContaining("annotations and links"),
    )

    // The plan is read off the seam, not the result: what each option does to
    // pages is the engine's tests' to say; this suite checks the call alone.
    await browser.execute(() => {
      const seam = window as unknown as {
        __tfolioE2E?: Record<string, unknown>
        __tfolioMergePlan?: unknown
      }

      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        mergePdfFiles: (plan: unknown) => {
          seam.__tfolioMergePlan = plan
          return Promise.reject(new Error("expected plan-test failure"))
        },
      }
    })

    await $("[data-testid='merge-wizard-bookmarks']").click()
    await $("[data-testid='merge-wizard-merge']").click()

    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            (window as unknown as { __tfolioMergePlan?: { normalizeA4?: boolean } })
              .__tfolioMergePlan?.normalizeA4,
        )) === true,
      { timeout: 15_000, timeoutMsg: "the A4 option never reached the merge" },
    )
  })

  it("skips disabled features and preserves drafts without applying them", async () => {
    const first = writeScratchPdf("options-first.pdf", minimalPdf(2))
    const second = writeScratchPdf("options-second.pdf", minimalPdf(1))
    await openWizardWith([first, second])
    await addPickedFiles(2)
    await setPageLayers(false, false)
    expect(await trailSteps()).toEqual(["Files", "Bookmarks"])
    await $("[data-testid='merge-wizard-bookmarks']").click()
    expect(await trailSteps()).toEqual(["Files"])
    await expect($("[data-testid='merge-wizard-merge']")).toBeEnabled()
    await expect($("[data-testid='merge-wizard-export-onePdf']")).not.toExist()
    await $("[data-testid='merge-wizard-page-numbers']").click()
    await $("[data-testid='merge-wizard-watermark']").click()
    expect(await trailSteps()).toEqual(["Files", "Page numbers", "Watermark"])
    await nextStep()
    await $("[data-testid='page-numbers-from']").setValue("99")
    await $("//button[normalize-space()='Back']").click()
    await $("[data-testid='merge-wizard-page-numbers']").click()
    await nextStep()
    await $("[data-testid='watermark-text']").setValue("DRAFT")
    await $("//button[normalize-space()='Back']").click()
    await nextStep()
    await expect($("[data-testid='watermark-text']")).toHaveValue("DRAFT")
    await $("[data-testid='watermark-text']").setValue("")
    await expect($("[data-testid='merge-wizard-merge']")).toBeDisabled()
    await $("//button[normalize-space()='Back']").click()
    await $("[data-testid='merge-wizard-watermark']").click()
    await expect($("[data-testid='merge-wizard-merge']")).toBeEnabled()
    await $("[data-testid='merge-wizard-merge']").click()
    await browser.waitUntil(async () => (await thumbCount()) === 3, { timeout: 30_000 })
    await $("[aria-label='Show bookmarks']").click()
    await expect($("aside")).toHaveText(expect.stringContaining("no bookmarks"))
    await $("button[aria-label='Page numbers']").click()
    await expect($("//button[normalize-space()='Remove page numbers']")).not.toExist()
  })

  it("clears the list and recalculates smart options after reordering", async () => {
    const first = writeScratchPdf("even.pdf", minimalPdf(2))
    const second = writeScratchPdf("odd.pdf", minimalPdf(3))
    await openWizardWith([first, second])
    await expect($("[data-testid='merge-wizard-clear']")).not.toExist()
    await expect($("[data-testid='merge-wizard-total']")).toHaveText("No files yet. Add at least two files to merge.")
    await $("[data-testid='merge-wizard-empty-add']").click()
    await browser.waitUntil(async () => (await listedNames()).length === 2, { timeout: 15_000 })
    await expect($("[data-testid='merge-wizard-padding']")).toHaveAttribute("aria-disabled", "true")
    await expect($("[aria-label='PDF document']")).toExist()
    await dragRow(1, 0, "above")
    await expect($("[data-testid='merge-wizard-padding']")).not.toHaveAttribute("aria-disabled", "true")
    await $("[data-testid='merge-wizard-padding']").click()
    await expect($("[data-testid='merge-wizard-total']")).toHaveText(expect.stringContaining("6 pages (including 1 added blank page)"))
    await dragRow(0, 1, "below")
    await expect($("[data-testid='merge-wizard-padding']")).toHaveAttribute("aria-checked", "false")
    await expect($("[data-testid='merge-wizard-padding']")).toHaveAttribute("aria-disabled", "true")
    await $("[data-testid='merge-wizard-clear']").click()
    expect(await listedNames()).toEqual([])
    await expect($("[data-testid='merge-wizard-next']")).toBeDisabled()
    await expect($("[data-testid='merge-wizard-clear']")).not.toExist()
  })

  it("disables A4 for portrait and landscape A4, then rechecks when files change", async () => {
    const a4 = writeScratchPdf("portrait-a4.pdf", minimalPdf(1, "0 0 595 842"))
    const landscape = writeScratchPdf("landscape-a4.pdf", minimalPdf(1, "0 0 842 595"))
    const small = writeScratchPdf("small.pdf", minimalPdf(1))
    await openWizardWith([a4, landscape])
    await addPickedFiles(2)
    await expect($("[data-testid='merge-wizard-a4']")).toHaveAttribute("aria-disabled", "true")
    await expect($("[data-testid='merge-wizard-files']")).toHaveText(expect.stringContaining("All pages are already A4"))
    await pointMultiPickerAt([small])
    await addPickedFiles(3)
    await $("[data-testid='merge-wizard-a4']").click()
    await expect($("[data-testid='merge-wizard-a4-warning']")).toBeDisplayed()
    await $("button[aria-label='Remove small.pdf']").click()
    await expect($("[data-testid='merge-wizard-a4']")).toHaveAttribute("aria-disabled", "true")
    await expect($("[data-testid='merge-wizard-a4']")).toHaveAttribute("aria-checked", "false")
    await expect($("[data-testid='merge-wizard-a4-warning']")).not.toExist()
  })

  it("uses the repeat pattern's starting watermark size", async () => {
    const first = writeScratchPdf("watermark-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("watermark-second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await $("[data-testid='merge-wizard-bookmarks']").click()
    await setPageLayers(false, true)
    await nextStep()

    const size = $("[data-testid='watermark-size']")
    await expect(size).toHaveText(expect.stringContaining("80%"))

    await $("//button[normalize-space()='Tiled']").click()
    await expect(size).toHaveText(expect.stringContaining("30%"))

    await $("//button[normalize-space()='Once']").click()
    await expect(size).toHaveText(expect.stringContaining("80%"))
  })

  it("writes one bookmark per file, keeping each file's own beneath it", async () => {
    const first = writeScratchPdf("Front matter.pdf", minimalPdf(1))
    const second = writeScratchPdf("Chapters.pdf", outlinedPdf())

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await setPageLayers(false, false)
    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-perFileWithExisting']").click()
    await $("[data-testid='merge-wizard-merge']").click()

    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeout: 30_000,
      timeoutMsg: "the merged document never opened",
    })

    // The sidebar reads the document's real outline, so this is PDFium's own
    // account of what the merge wrote.
    await $("[aria-label='Show bookmarks']").click()

    const titles = await browser.execute(() =>
      [...document.querySelectorAll("aside nav button")].map(
        (button) => button.textContent?.trim() ?? "",
      ),
    )

    expect(titles).toEqual(["Front matter", "Chapters", "Second half"])
  })

  it("reorders the list by dragging a row into another's place", async () => {
    const paths = ["a", "b", "c"].map((name) =>
      writeScratchPdf(`${name}.pdf`, minimalPdf(1)),
    )

    await openWizardWith(paths)
    await addPickedFiles(3)
    expect(await listedNames()).toEqual(["a.pdf", "b.pdf", "c.pdf"])

    // Hold it beyond the scroll box's top edge: the moving copy belongs to the
    // document root, so overflow cannot cut off the part outside the list.
    await dragRow(2, 0, "above", false)
    await browser.waitUntil(
      () => $("[data-slot='merge-file-drag-ghost']").isExisting(),
      { timeout: 15_000, timeoutMsg: "the drag ghost never appeared" },
    )
    const ghost = await browser.execute(() => {
      const moving = document.querySelector<HTMLElement>(
        "[data-slot='merge-file-drag-ghost']",
      )!
      const list = document.querySelector<HTMLElement>(
        "[data-slot='merge-file']",
      )!.parentElement!

      return {
        escapedTop:
          moving.getBoundingClientRect().top < list.getBoundingClientRect().top,
        atRoot: moving.parentElement === document.body,
      }
    })

    expect(ghost).toEqual({ atRoot: true, escapedTop: true })
    await releaseRow()
    await browser.waitUntil(async () => (await listedNames())[0] === "c.pdf", {
      timeout: 15_000,
      timeoutMsg: "the dragged row never moved",
    })
    expect(await listedNames()).toEqual(["c.pdf", "a.pdf", "b.pdf"])

    await dragRow(0, 2, "below")
    await browser.waitUntil(async () => (await listedNames())[2] === "c.pdf", {
      timeout: 15_000,
      timeoutMsg: "the row never went back to the end",
    })
    expect(await listedNames()).toEqual(["a.pdf", "b.pdf", "c.pdf"])
  })

  it("scrolls the list rather than the step around it", async () => {
    const paths = Array.from({ length: 12 }, (_, index) =>
      writeScratchPdf(`file-${index}.pdf`, minimalPdf(1)),
    )

    await openWizardWith(paths)
    await addPickedFiles(12)

    // The list has its own scroll box, so the controls under it stay put.
    const overflow = await browser.execute(() => {
      const list = document.querySelector("[data-slot='merge-file']")
        ?.parentElement

      return list
        ? { scrollable: list.scrollHeight > list.clientHeight + 1 }
        : null
    })

    expect(overflow?.scrollable).toBe(true)
    await expect($("[data-testid='merge-wizard-add']")).toBeDisplayed()
    await expect($("[data-testid='merge-wizard-total']")).toBeDisplayed()
  })

  it("holds one frame height across the steps and their switches", async () => {
    const first = writeScratchPdf("frame-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("frame-second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)

    // `offsetHeight`, not a rect: the dialog's opening zoom is a transform,
    // and a rect read inside its 100 ms would measure the scaled frame.
    const frameHeight = () =>
      browser.execute(
        () =>
          document.querySelector<HTMLElement>("[data-testid='merge-wizard']")!
            .offsetHeight,
      )

    // The tallest step sets the one rectangle every step and switch state is
    // shown in, so nothing below the frame moves as the steps change. Each
    // step's content is awaited before measuring, so the frame is read settled.
    const heights = [await frameHeight()]

    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-perFile']").waitForExist({
      timeout: 15_000,
    })
    heights.push(await frameHeight())

    await nextStep()
    await $("[data-testid='page-numbers-from']").waitForExist({
      timeout: 15_000,
    })
    heights.push(await frameHeight())

    await nextStep()
    await $("[data-testid='watermark-text']").waitForExist({
      timeout: 15_000,
    })
    heights.push(await frameHeight())

    expect(new Set(heights).size).toBe(1)
  })

  it("keeps a file it cannot read out of the merge", async () => {
    const good = writeScratchPdf("good.pdf", minimalPdf(2))
    const alsoGood = writeScratchPdf("also-good.pdf", minimalPdf(1))
    const broken = writeScratchPdf(
      "broken.pdf",
      Buffer.from("not a pdf at all", "ascii"),
    )

    await openWizardWith([good, broken, alsoGood])
    await addPickedFiles(3)

    // The unusable row stays on the list the reader built, and says why; only
    // the three readable pages count towards the merge.
    await expect($("[data-testid='merge-wizard-total']")).toHaveText(
      expect.stringContaining("3"),
    )
    await expect($("[data-testid='merge-wizard-next']")).toBeEnabled()
  })

  it("names what a Word document needs when no office app can convert it", async () => {
    const pdf = writeScratchPdf("with-word.pdf", minimalPdf(2))
    // The e2e build finds no conversion engine by design, so whatever bytes
    // sit under the extension answer with the same wording every time.
    const word = writeScratchPdf("letter.docx", Buffer.from("not a docx", "ascii"))

    await openWizardWith([pdf, word])
    await addPickedFiles(2)

    // The Word row stays, unusable, and says what to install rather than
    // "unreadable" — and with one usable file left, the step is not answered.
    const statuses = await $$("[data-testid='merge-file-status']")
      .map((status) => status.getText())

    expect(statuses[1]).toContain("Needs Word, WPS, or LibreOffice")
    await expect($("[data-testid='merge-wizard-next']")).toBeDisabled()
  })
})
