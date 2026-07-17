import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"
import { viewModeStorageKey } from "../../src/lib/viewMode"

// A content-free PDF of `pageCount` pages, portrait unless `mediaBox` says
// otherwise. Page objects take the odd ids from 3 up, each followed by its
// (empty) contents stream.
function minimalPdf(pageCount = 1, mediaBox = "0 0 200 300") {
  const kids = Array.from(
    { length: pageCount },
    (_, index) => `${3 + index * 2} 0 R`,
  ).join(" ")
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
  ]

  for (let index = 0; index < pageCount; index += 1) {
    const pageId = 3 + index * 2

    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] ` +
        `/Contents ${pageId + 1} 0 R >>\nendobj\n`,
      `${pageId + 1} 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n`,
    )
  }

  const chunks = ["%PDF-1.4\n"]
  const offsets: number[] = []
  let byteLength = Buffer.byteLength(chunks[0], "ascii")

  for (const object of objects) {
    offsets.push(byteLength)
    chunks.push(object)
    byteLength += Buffer.byteLength(object, "ascii")
  }

  const xrefOffset = byteLength
  chunks.push(`xref\n0 ${objects.length + 1}\n`)
  chunks.push("0000000000 65535 f \n")

  for (const offset of offsets) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }

  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  )

  return Buffer.from(chunks.join(""), "ascii")
}

async function selectFile(name: string, type: string, contents: Uint8Array) {
  await browser.execute(({ bytes, fileName, mimeType }) => {
    const input = document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )

    if (!input) {
      throw new Error("PDF file input was not found")
    }

    const file = new File([new Uint8Array(bytes)], fileName, {
      type: mimeType,
    })

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    })
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }, {
    bytes: Array.from(contents),
    fileName: name,
    mimeType: type,
  })
}

describe("TFolio PDF viewer", () => {
  before(async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        // The view mode persists, so drop it to start from the single view.
        window.localStorage.removeItem(keys.viewMode)
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await $("input[aria-label='Choose a PDF file']").waitForExist()
  })

  it("starts with the isolated WDIO bridge available", async () => {
    const location = await browser.tauri.execute(() => window.location.href)
    const chooseFile = await $("input[aria-label='Choose a PDF file']")

    await expect(chooseFile).toExist()
    expect(location).toContain("tauri")
  })

  it("rejects invalid input, renders a PDF, and exercises viewer controls", async () => {
    await selectFile(
      "not-a-pdf.txt",
      "text/plain",
      Buffer.from("not a PDF", "utf8"),
    )
    await expect($("[role='alert']")).toHaveText("Please choose a PDF file.")

    await selectFile("one-page.pdf", "application/pdf", minimalPdf())

    const firstPage = await $("[data-page-number='1']")
    await firstPage.waitForDisplayed()
    await expect($("[data-slot='page-status']")).toHaveAttribute(
      "aria-label",
      "Page 1 of 1",
    )

    const canvas = await firstPage.$("canvas")
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) > 200,
      {
        timeout: 15_000,
        timeoutMsg: "PDF page did not finish rendering through PDFium",
      },
    )

    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("99")
    await browser.keys("Enter")
    await expect(pageInput).toHaveValue("1")

    await $("button[aria-label='Show bookmarks']").click()
    await expect($("nav[aria-label='Bookmarks']")).toHaveText(
      "This document has no bookmarks.",
    )

    await $("button[aria-label='Settings']").click()
    await expect($("[role='dialog']")).toBeDisplayed()

    // The About section preserves the existing application information.
    await $("[role='tab'][aria-controls='settings-panel-about']").click()
    await expect($("#settings-panel-about")).toBeDisplayed()

    // The Appearance section switches the color theme. Selecting Light then Dark
    // proves the toggle works regardless of the operating system's default scheme
    // (under "follow system" the app may already be dark before the click).
    await $("[role='tab'][aria-controls='settings-panel-appearance']").click()
    await $("//button[@role='radio' and normalize-space()='Light']").click()
    const isDarkAfterLight = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterLight).toBe(false)

    await $("//button[@role='radio' and normalize-space()='Dark']").click()
    const isDarkAfterDark = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterDark).toBe(true)

    // …and the interface language.
    await $("#settings-language").click()
    await $(
      "//*[@role='option' and normalize-space()='Simplified Chinese']",
    ).click()

    const documentLanguage = await browser.execute(
      () => document.documentElement.lang,
    )
    expect(documentLanguage).toBe("zh-CN")
  })

  it("switches between the single, book, and thumbnail views", async () => {
    // This test both asserts the single-view default and leaves a mode behind,
    // so it clears the key itself rather than leaning on the one-time `before`.
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.removeItem(keys.viewMode)
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await selectFile("nine-pages.pdf", "application/pdf", minimalPdf(9))
    await $("[data-page-number='1']").waitForDisplayed()

    const toggle = (label: string) => $(`button[aria-label='${label}']`)
    const pageInput = await $("input[aria-label='Page number']")

    await expect(toggle("Single page")).toHaveAttribute("aria-pressed", "true")

    // Book view pairs from page 1, so pages 1 and 2 share a spread.
    await toggle("Book").click()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
    await $("[data-page-number='2']").waitForDisplayed()

    const spread = await browser.execute(() => {
      const rowOf = (pageNumber: number) =>
        document.querySelector(`[data-page-number='${pageNumber}']`)
          ?.parentElement

      return {
        pairsFirstTwo: rowOf(1) === rowOf(2),
        startsNewRowOnThird: rowOf(1) !== rowOf(3),
        // The trailing odd page keeps the left cell, alone in its row.
        trailingRowSize: rowOf(9)?.childElementCount,
      }
    })
    expect(spread.pairsFirstTwo).toBe(true)
    expect(spread.startsNewRowOnThird).toBe(true)
    expect(spread.trailingRowSize).toBe(1)

    // Each layout stacks to a different height, and the viewer keeps its scroll
    // offset across a switch, so the reader's page has to be sought back out.
    await toggle("Single page").click()
    await pageInput.setValue("5")
    await browser.keys("Enter")
    await browser.pause(1500)
    await expect(pageInput).toHaveValue("5")
    await toggle("Book").click()
    // Give the page tracker time to settle. It only revises the current page
    // once the new layout has mounted, so asserting right away would pass
    // against the stale value before the layout can strand it.
    await browser.pause(1500)
    await expect(pageInput).toHaveValue("5")

    // Thumbnails are navigation targets: an image, and no selectable text layer.
    await toggle("Thumbnails").click()
    const thirdThumbnail = await $("button[aria-label='Go to page 3']")
    await thirdThumbnail.waitForDisplayed()
    await expect($$(".pdf-text-layer")).toBeElementsArrayOfSize(0)

    // Clicking one drops back into the single view at that page.
    await thirdThumbnail.click()
    await expect(toggle("Single page")).toHaveAttribute("aria-pressed", "true")
    await expect(pageInput).toHaveValue("3")

    // The chosen mode outlives a reload.
    await toggle("Book").click()
    await browser.refresh()
    await $("input[aria-label='Choose a PDF file']").waitForExist()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
  })

  // Landscape thumbnail rows are a fraction of a page's height. Page tracking
  // must not assume a row is tall enough to reach some fixed depth down the
  // viewer, or navigation lands on a row and the tracker reports a later one.
  it("stays on the requested page in a grid of landscape pages", async () => {
    await browser.execute(
      (keys) => {
        window.localStorage.setItem(keys.language, "en")
        window.localStorage.removeItem(keys.viewMode)
      },
      { language: languageStorageKey, viewMode: viewModeStorageKey },
    )
    await browser.refresh()
    await selectFile(
      "landscape.pdf",
      "application/pdf",
      minimalPdf(40, "0 0 300 200"),
    )
    await $("[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Go to page 1']").waitForDisplayed()

    // The grid fits as many columns as the window allows, so derive a page that
    // really does start a row rather than hard-coding one.
    const columns = await browser.execute(() => {
      const cellTop = (pageNumber: number) =>
        document
          .querySelector(`[data-page-number='${pageNumber}']`)!
          .getBoundingClientRect().top
      const firstTop = cellTop(1)
      let count = 0

      for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
        if (Math.abs(cellTop(pageNumber) - firstTop) < 1) count += 1
      }

      return count
    })

    const target = String(1 + columns * 3) // leftmost cell of the fourth row
    const pageInput = await $("input[aria-label='Page number']")

    await pageInput.setValue(target)
    await browser.keys("Enter")
    // Let the tracker settle: it revises the page only after the scroll lands,
    // so asserting straight away would pass against the pre-scroll value.
    await browser.pause(1500)
    await expect(pageInput).toHaveValue(target)
  })
})
