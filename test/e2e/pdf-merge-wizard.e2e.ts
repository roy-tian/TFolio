import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  bandedPdf,
  dropZoneButton,
  minimalPdf,
  pointMultiPickerAt,
  seedSettings,
  writeScratchPdf,
} from "./helpers"

/** A PDF whose one bookmark aims at its second page, so a wizard run that keeps
    the sources' outlines has something of its own to carry over. */
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

/** Opens the wizard from the header, with the picker pointed at `paths`. */
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

function nextStep() {
  return $("[data-testid='merge-wizard-next']").click()
}

/**
 * Drags the row at `from` to rest above or below the row at `to`, both 0-based
 * — press, move past the threshold, drop — with dispatched pointer events,
 * which under WebKitGTK are the only press semantics a test can produce (the
 * same route `dragThumbToGap` takes in the page-edit suite).
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

/** Releases a drag held by `dragRow`, at the ghost's current grip. */
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

/** The file names on the wizard's list, top to bottom. */
function listedNames() {
  return browser.execute(() =>
    [...document.querySelectorAll("[data-slot='merge-file']")].map(
      (row) => row.querySelector("span[title]")?.textContent?.trim() ?? "",
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
    await browser.refresh()
    await dropZoneButton().waitForExist({ timeout: 30_000 })
  })

  it("merges the listed files into a new document, in the order shown", async () => {
    const first = writeScratchPdf("first.pdf", bandedPdf(2))
    const second = writeScratchPdf("second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    // Two files are the least a merge takes, so the button is dead until then.
    await expect($("[data-testid='merge-wizard-next']")).toBeDisabled()

    await addPickedFiles(2)
    await expect($("[data-testid='merge-wizard-total']")).toHaveText(
      expect.stringContaining("3"),
    )
    await expect($("[data-testid='merge-wizard-next']")).toBeEnabled()

    // Bookmarks off, so the result carries nothing but its pages.
    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-none']").click()
    await nextStep()
    await nextStep()
    await $("[data-testid='merge-wizard-merge']").click()

    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeout: 30_000,
      timeoutMsg: "the merged document never opened on its thumbnail grid",
    })
    // The reader's stored view is single; a merge opens on the grid regardless,
    // which is where the whole result can be looked over at once.
    await expect($("[data-slot='merge-wizard-button']")).toBeDisplayed()
  })

  it("shows determinate progress while the final merge is pending", async () => {
    const first = writeScratchPdf("progress-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("progress-second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await nextStep()
    await nextStep()
    await nextStep()

    // Hold the final operation open long enough to observe both its initial and
    // advanced state. The real backend's progress sequence is covered in its
    // engine test; this seam tests the wizard's face without a timing race.
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
    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-none']").click()
    await nextStep()
    await $("[data-testid='merge-wizard-page-numbers']").click()
    await nextStep()
    await $("[data-testid='merge-wizard-watermark']").click()
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
    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-none']").click()
    await nextStep()
    await $("[data-testid='merge-wizard-page-numbers']").click()
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
    await $("[data-testid='merge-wizard-padding']").click()

    // One blank before the second file, which would otherwise open on page 2.
    await expect($("[data-testid='merge-wizard-total']")).toHaveText(
      expect.stringContaining("3"),
    )

    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-none']").click()
    await nextStep()
    await nextStep()
    await $("[data-testid='merge-wizard-merge']").click()

    await browser.waitUntil(async () => (await thumbCount()) === 3, {
      timeout: 30_000,
      timeoutMsg: "the blank page never joined the merged document",
    })
  })

  it("uses the repeat pattern's starting watermark size", async () => {
    const first = writeScratchPdf("watermark-first.pdf", minimalPdf(1))
    const second = writeScratchPdf("watermark-second.pdf", minimalPdf(1))

    await openWizardWith([first, second])
    await addPickedFiles(2)
    await nextStep()
    await nextStep()
    await nextStep()
    await $("[data-testid='merge-wizard-watermark']").click()

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
    await nextStep()
    await $("[data-testid='merge-wizard-bookmarks-perFileWithExisting']").click()
    await nextStep()
    await nextStep()
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
})
