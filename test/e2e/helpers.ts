// WebDriver drives neither native dialogs nor native drops, and Tauri seals
// `__TAURI_INTERNALS__`, so openers stub `window.__tfolioE2E` and drive the real UI.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { $, $$, browser, expect } from "@wdio/globals"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { PdfExportOutcome } from "../../src/lib/pdf"
import type { Settings } from "../../src/lib/settings"

/** Where the backend keeps this build's settings: the lane's app data
    directory, known only once the worker's session starts — read per call. */
function settingsFile() {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"),
    "com.roytian.tfolio.e2e",
    "settings.toml",
  )
}

/** The recent-file list the same backend keeps, beside those settings: what
    the next run's home tab reads, so a removal must reach it. */
export function recentFilesStore() {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"),
    "com.roytian.tfolio.e2e",
    "recent-files.toml",
  )
}

export function minimalPdf(
  pageCount = 1,
  mediaBox: string | ((index: number) => string) = "0 0 200 300",
) {
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
    const box = typeof mediaBox === "function" ? mediaBox(index) : mediaBox

    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${box}] ` +
        `/Contents ${pageId + 1} 0 R >>\nendobj\n`,
      `${pageId + 1} 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n`,
    )
  }

  return buildPdf(objects)
}

export function blankPdf() {
  return minimalPdf(1, "0 0 300 400")
}

/** Two pages, with one bookmark pointing at the second. */
export function outlinedPdf() {
  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n",
    "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
    "6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>\nendobj\n",
    "7 0 obj\n<< /Title (Second half) /Parent 6 0 R /Dest [4 0 R /XYZ null null null] >>\nendobj\n",
  ])
}

/** Two pages under two bookmarks, the first with one of its own beneath it. */
export function nestedOutlinePdf() {
  const dest = (page: number) => `/Dest [${page} 0 R /XYZ null null null]`

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 5 0 R >>\nendobj\n",
    "5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
    "6 0 obj\n<< /Type /Outlines /First 7 0 R /Last 9 0 R /Count 3 >>\nendobj\n",
    `7 0 obj\n<< /Title (Part one) /Parent 6 0 R /Next 9 0 R /First 8 0 R /Last 8 0 R /Count 1 ${dest(3)} >>\nendobj\n`,
    `8 0 obj\n<< /Title (Chapter one) /Parent 7 0 R ${dest(4)} >>\nendobj\n`,
    `9 0 obj\n<< /Title (Part two) /Parent 6 0 R /Prev 7 0 R ${dest(4)} >>\nendobj\n`,
  ])
}

export function bandedPdf(pageCount: number) {
  const kids = Array.from(
    { length: pageCount },
    (_, index) => `${3 + index} 0 R`,
  ).join(" ")
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
  ]

  for (let index = 0; index < pageCount; index += 1) {
    objects.push(
      `${3 + index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] ` +
        `/Contents ${3 + pageCount + index} 0 R >>\nendobj\n`,
    )
  }

  for (let index = 0; index < pageCount; index += 1) {
    const content = `0 0 0 rg\n${20 + (index % 4) * 40} 100 30 120 re f\n`

    objects.push(
      `${3 + pageCount + index} 0 obj\n<< /Length ${content.length} >>\n` +
        `stream\n${content}endstream\nendobj\n`,
    )
  }

  return buildPdf(objects)
}

export function stripedPdf() {
  let content = "0 0 0 rg\n"

  for (let left = 90; left < 210; left += 4) {
    content += `${left} 120 2 160 re f\n`
  }

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  ])
}

export function textPdf(pageCount = 1) {
  const fontId = 3 + pageCount * 2
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageId = 3 + index
    const contentId = 3 + pageCount + index

    return (
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>\nendobj\n`
    )
  })
  const contents = Array.from({ length: pageCount }, (_, index) => {
    const contentId = 3 + pageCount + index
    const content =
      `BT\n/F1 24 Tf\n40 200 Td\n(Highlight me please ${index + 1}) Tj\nET\n`

    return (
      `${contentId} 0 obj\n<< /Length ${content.length} >>\n` +
      `stream\n${content}endstream\nendobj\n`
    )
  })

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${pages
      .map((_, index) => `${3 + index} 0 R`)
      .join(" ")}] /Count ${pageCount} >>\nendobj\n`,
    ...pages,
    ...contents,
    `${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ])
}

export function shortLastLinePdf() {
  const content = "BT /F1 14 Tf 30 330 Td (A long first line followed by a very short final line) Tj 0 -25 Td (End) Tj ET\n"
  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 400] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
}

/** Some PDF exporters position each glyph separately, giving neighboring
    characters different ink heights instead of one shared line box. */
export function fragmentedTextPdf(compact = false) {
  let content = ""

  for (let row = 0; row < 6; row += 1) {
    for (const [column, glyph] of [..."Selectable"].entries()) {
      const size = compact ? 14 + column * 0.13 : 8 + row * 3 + column * 0.13
      const pitch = compact ? 12 : 22
      content += `BT /F1 ${size} Tf 1 0 0 1 ${40 + column * pitch} ${350 - row * 55} Tm (${glyph}) Tj ET\n`
    }
  }

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
}

/** Column-major prose and row-major table cells deliberately have different
    reading orders. Each glyph is a separate PDF text object. */
export function fragmentedColumnsPdf(table = false) {
  let content = ""
  const cells = table ? [[0, 0], [0, 1], [1, 0], [1, 1]] : [[0, 0], [1, 0], [0, 1], [1, 1]]
  for (const [row, column] of cells) {
    const text = column ? "RightText" : "LeftWords"
    for (const [index, glyph] of [...text].entries()) {
      content += `BT /F1 ${14 + index * 0.13} Tf 1 0 0 1 ${40 + column * 280 + index * 13} ${680 - row * 45} Tm (${glyph}) Tj ET\n`
    }
  }
  if (table) {
    for (const y of [660, 705, 615]) content += `30 ${y} m 580 ${y} l S\n`
    for (const x of [30, 300, 580]) content += `${x} 615 m ${x} 705 l S\n`
  }
  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
}

/** Every page's rows of `glyphPagesPdf`, distinct so a misplaced one shows. */
export const GLYPH_PAGE_ROWS = Array.from({ length: 30 }, (_, row) => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  const rotated = letters.slice(row % 26) + letters.slice(0, row % 26)

  // Past one full turn, reversed so no row repeats another.
  return row < 26 ? rotated : [...rotated].reverse().join("")
})

/** Each glyph its own text object, and so its own run: 780 a page, which take
    several frames to build. Courier's set advance leaves no gap between glyphs
    for PDFium to read as a space. */
export function glyphPagesPdf(pageCount: number) {
  let content = ""

  for (const [row, text] of GLYPH_PAGE_ROWS.entries()) {
    for (const [column, glyph] of [...text].entries()) {
      content += `BT /F1 10 Tf 1 0 0 1 ${40 + column * 6} ${370 - row * 12} Tm (${glyph}) Tj ET\n`
    }
  }

  const contentId = 3 + pageCount
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index} 0 R`).join(" ")

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`,
    ...Array.from({ length: pageCount }, (_, index) =>
      `${3 + index} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] ` +
        `/Resources << /Font << /F1 ${contentId + 1} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`),
    `${contentId} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    `${contentId + 1} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n`,
  ])
}

/** A heading in one column spans both body lines in the other column. */
export function mixedSizeColumnsPdf() {
  const content =
    "BT /F1 34 Tf 50 668 Td (TITLE) Tj ET\n" +
    "BT /F1 12 Tf 310 684 Td (First body line) Tj ET\n" +
    "BT /F1 12 Tf 310 672 Td (Second line) Tj ET\n"

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
}

export function wrappedSearchPdf() {
  const first =
    "BT\n/F1 24 Tf\n40 250 Td\n(Wrapped) Tj\n0 -30 Td\n(phrase) Tj\nET\n"
  const second = "BT\n/F1 24 Tf\n40 200 Td\n(WRAPPED PHRASE) Tj\nET\n"

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\nendobj\n",
    `5 0 obj\n<< /Length ${first.length} >>\nstream\n${first}endstream\nendobj\n`,
    `6 0 obj\n<< /Length ${second.length} >>\nstream\n${second}endstream\nendobj\n`,
    "7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
}

/**
 * One page of text carrying a signature field whose widget shows a red seal,
 * signed over the whole file. The `/Contents` is no real CMS: the app checks
 * only that the byte range frames it, which this does exactly as a signer's.
 */
export function signedPdf() {
  const placeholder = "[0 0000000000 0000000000 0000000000]"
  const text = "BT\n/F1 24 Tf\n40 200 Td\n(Highlight me please 1) Tj\nET\n"
  const seal = "1 0 0 rg 10 10 80 80 re f"
  const contents =
    Array.from({ length: 64 }, (_, byte) => byte.toString(16).padStart(2, "0")).join("") +
    "00".repeat(192)
  const pdf = buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R " +
      "/AcroForm << /Fields [5 0 R] /SigFlags 3 >> >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Resources << /Font << /F1 8 0 R >> >> /Contents 4 0 R /Annots [5 0 R] >>\nendobj\n",
    `4 0 obj\n<< /Length ${text.length} >>\nstream\n${text}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /T (Seal) " +
      "/Rect [180 20 280 120] /F 4 /P 3 0 R /V 7 0 R /AP << /N 6 0 R >> >>\nendobj\n",
    "6 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] " +
      `/Length ${seal.length + 1} >>\nstream\n${seal}\nendstream\nendobj\n`,
    "7 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached " +
      `/ByteRange ${placeholder} /Contents <${contents}> >>\nendobj\n`,
    "8 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
  const start = pdf.indexOf("/Contents <") + "/Contents ".length
  const end = start + contents.length + 2
  const byteRange = `[0 ${start} ${end} ${pdf.length - end}]`.padEnd(placeholder.length)

  pdf.write(byteRange, pdf.indexOf(placeholder), "ascii")

  return pdf
}

/** Selects the page's one text run and lets go, the way the reader highlights:
    the press has to land on the text for the release to commit. */
export async function highlightTheText() {
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

function buildPdf(objects: string[]) {
  const chunks = ["%PDF-1.4\n"]
  const offsets: number[] = []
  let byteLength = Buffer.byteLength(chunks[0], "ascii")

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

/**
 * Written into the backend's own settings file, so they survive the refresh
 * that applies them; the whole document is replaced, so a spec inherits nothing.
 */
export async function seedSettings(settings: Settings = {}) {
  // The write goes through the backend and needs a booted page — one still
  // booting loses it when the app replaces it — so the wait lives here.
  await openFileButton().waitForExist({ timeout: 30_000 })

  // Cleared first: its reappearance is the signal. Polling the file costs the
  // fragile bridge no round trips and checks what the app will actually read.
  const settingsPath = settingsFile()
  rmSync(settingsPath, { force: true })

  // The promise stays in the page — this driver cannot serialise one back
  // ("Unsupported result type") — and the payload stays a string, as always.
  await browser.execute((json: string) => {
    const tauri = (
      window as Window & {
        __TAURI__?: {
          core: { invoke: (command: string, args?: unknown) => Promise<unknown> }
        }
      }
    ).__TAURI__

    void tauri?.core.invoke("set_settings", {
      settings: JSON.parse(json) as unknown,
    })
  }, JSON.stringify(settings))

  // Not merely that a file is there again — that it holds what was just asked
  // for, so a write still in flight from the spec before cannot satisfy this.
  await settingsHold(seededValues(settings))
}

/** Waits until the settings file holds every one of `wanted`. */
export async function settingsHold(wanted: string[]) {
  await browser.waitUntil(
    () => {
      const settingsPath = settingsFile()

      if (!existsSync(settingsPath)) {
        return false
      }

      // A half-written file simply fails the check and is polled again.
      const written = readFileSync(settingsPath, "utf8")

      return wanted.every((value) => written.includes(value))
    },
    { timeout: 15_000, timeoutMsg: "the settings never reached the backend" },
  )
}

/** Every string a seeded document puts in the file. */
function seededValues(settings: object): string[] {
  return Object.values(settings).flatMap((value: unknown) => {
    if (typeof value === "string") {
      return [value]
    }

    return typeof value === "object" && value !== null ? seededValues(value) : []
  })
}

/**
 * The stamp tells the new page from the dying one, and the pause plus 40s
 * budget ride out a teardown race that hangs a lost injection a hard 30s.
 */
export async function refreshApp() {
  await browser.execute(() => {
    const stamped = window as Window & { __tfolioReloadStamp?: boolean }
    stamped.__tfolioReloadStamp = true
  })
  await browser.refresh()
  await browser.pause(250)
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute(() => {
          const stamped = window as Window & { __tfolioReloadStamp?: boolean }

          return (
            stamped.__tfolioReloadStamp === undefined &&
            !!document.querySelector("[data-slot='tab-open-file']")
          )
        })
      } catch {
        return false
      }
    },
    {
      timeout: 40_000,
      timeoutMsg: "the app never came back from its refresh",
    },
  )
}

/** In the page whichever tab shows, so it doubles as the booted signal; only
    clickable while the home tab is up. By slot, not the language's label. */
export function dropZoneButton() {
  return $("[data-slot='drop-zone']")
}

export function openFileButton() {
  return $("[data-slot='tab-open-file']")
}

/**
 * Hovers `selector`: WebKitGTK's embedded WebDriver moves the pointer without
 * the WebView ever seeing a hover, so Base UI's events are dispatched in the page.
 */
export async function hoverElement(selector: string) {
  await $(selector).waitForExist({ timeout: 15_000 })
  await browser.execute((css: string) => {
    const node = document.querySelector(css)!
    const box = node.getBoundingClientRect()
    const init = {
      bubbles: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      pointerType: "mouse",
    }

    // Hints outside one delay group do not close each other, so the hover is
    // taken back first: the popup read below must be this hover's own.
    for (const open of document.querySelectorAll(
      "[data-base-ui-tooltip-trigger][data-popup-open]",
    )) {
      if (open !== node) {
        open.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
        open.dispatchEvent(new MouseEvent("mouseleave"))
      }
    }

    node.dispatchEvent(new PointerEvent("pointerover", init))
    node.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false }))
    node.dispatchEvent(new MouseEvent("mouseover", init))
    node.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false }))
    node.dispatchEvent(new MouseEvent("mousemove", init))
  }, selector)
}

export function tooltipOpen(selector: string) {
  return browser.execute(
    (css: string) =>
      document.querySelector(css)?.hasAttribute("data-popup-open") ?? false,
    selector,
  )
}

export async function tooltipOn(selector: string) {
  await hoverElement(selector)
  await browser.waitUntil(async () => tooltipOpen(selector), {
    timeout: 15_000,
    timeoutMsg: `no tooltip opened on ${selector}`,
  })

  // The newest popup is this one: portals are appended as they open, and every
  // hint hovered before this one has been let go of above.
  return browser.execute(() => {
    const open = document.querySelectorAll(
      "[data-slot='tooltip-content'][data-open]",
    )

    return open[open.length - 1]?.textContent?.trim() ?? ""
  })
}

/**
 * Opens the header's menu — where commands without a toolbar key live — and
 * answers the item for `action`, by `data-action` not the language's label.
 */
export async function appMenuItem(action: string) {
  await $("[data-slot='app-menu']").click()

  const item = $(`[data-action='${action}']`)
  await item.waitForDisplayed({ timeout: 15_000 })

  return item
}

/** The shown tab's sidebar: every tab mounts its own, the others hidden. */
export const activeSidebar =
  "[data-document-session][data-active='true'] [data-slot='app-sidebar']"

/** Opens a page's menu in the shown tab's sidebar, which also chooses the
    page if it was not chosen, and takes the action named by `data-action`. */
export function sidebarPageAction(pageNumber: number, action: string) {
  return contextMenuAction(
    `${activeSidebar} button[data-thumbnail-page='${pageNumber}']`,
    action,
  )
}

/** A right-click on `selector`'s middle, then its menu's entry `action`. */
export async function contextMenuAction(selector: string, action: string) {
  await $(selector).waitForExist({ timeout: 30_000 })
  await browser.execute((target: string) => {
    const page = document.querySelector(target)!
    const box = page.getBoundingClientRect()

    page.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    )
  }, selector)

  const item = $(`[data-action='${action}']`)

  await item.waitForDisplayed({ timeout: 5_000 })
  await item.click()
  await item.waitForDisplayed({ reverse: true, timeout: 5_000 })
}

/** A small, undoable edit: one page deleted through the shown tab's sidebar. */
export function deletePageFromSidebar(pageNumber = 1) {
  return sidebarPageAction(pageNumber, "delete-pages")
}

/** Redo by its key; the toolbar button is a click away too. */
export async function pressRedo() {
  await browser.keys(["Control", "Shift", "z"])
}

export async function clickAppMenuItem(action: string) {
  await (await appMenuItem(action)).click()
}

/**
 * Dismisses the menu and waits for its popup to actually leave the screen — the
 * next click would otherwise land on the closing popup, not the control behind.
 */
export async function closeAppMenu(
  item: Awaited<ReturnType<typeof appMenuItem>>,
) {
  await browser.keys("Escape")
  await item.waitForDisplayed({ reverse: true, timeout: 15_000 })
}

/**
 * Whether the menu currently offers `action`, closing it again — Base UI marks
 * a disabled item with `data-disabled`, which `isEnabled` never reads.
 */
export async function appMenuItemEnabled(action: string) {
  const item = await appMenuItem(action)
  const disabled = await item.getAttribute("data-disabled")
  await closeAppMenu(item)

  return disabled === null
}

/** Removed on process exit: a spec's files must outlive its last assertion,
    and only a synchronous exit hook can be relied on for that. */
const scratchDirectories: string[] = []

process.on("exit", () => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { force: true, recursive: true })
  }
})

/**
 * Writes `contents` to a scratch file and opens it through the real flow, only
 * the dialog stubbed. The returned path is where a save will land.
 */
export async function openPdfFromDisk(
  fileName: string,
  contents: Uint8Array,
): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-e2e-"))
  scratchDirectories.push(directory)
  const filePath = path.join(directory, fileName)
  writeFileSync(filePath, contents)
  await openPathViaDialog(filePath)

  return filePath
}

/**
 * Points the picker seam at `filePath` and opens from the tab strip, on screen
 * whatever is already open — one helper serves first document and later alike.
 */
export async function openPathViaDialog(filePath: string) {
  // A refresh can resolve before the new page has booted; the strip's open
  // button appearing is what proves the seam lands on the page that reads it.
  await openFileButton().waitForExist({ timeout: 30_000 })
  await pointPickerAt(filePath)
  await openFileButton().click()
}

/**
 * Writes `contents` to a scratch file and answers its path, unopened — the
 * files added to a document are read without being opened.
 */
export function writeScratchPdf(fileName: string, contents: Uint8Array): string {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-e2e-"))
  scratchDirectories.push(directory)
  const filePath = path.join(directory, fileName)

  writeFileSync(filePath, contents)

  return filePath
}

/** The multi-select stand-in adding files reads, left beside
    whatever other override is already in place. */
export async function pointMultiPickerAt(filePaths: string[]) {
  await browser.execute((mockPaths: string[]) => {
    const seam = window as Window & { __tfolioE2E?: E2eOverrides }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      pickPdfPaths: () => Promise.resolve(mockPaths),
    }
  }, filePaths)
}

/** Answers Save As's dialog with `destination` and runs the real write behind
    it, through the command the e2e build keeps for this. */
export async function pointSaveAsAt(destination: string) {
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

/** Writes the picker stand-in without disturbing any other override. */
export async function pointPickerAt(filePath: string) {
  await browser.execute((mockPath: string) => {
    const seam = window as Window & { __tfolioE2E?: E2eOverrides }

    seam.__tfolioE2E = {
      ...seam.__tfolioE2E,
      pickPdfPath: () => Promise.resolve(mockPath),
    }
  }, filePath)
}

type BytesOpenPrior = Partial<
  Pick<E2eOverrides, "openPdfFromPath" | "pickPdfPath">
>

/**
 * Opens `contents` with no path at all — the byte-payload `open_pdf` command is
 * the only route to the pathless state the save key's disabled case needs.
 */
export async function openPdfFromBytes(fileName: string, contents: Uint8Array) {
  const tabsNamed = () =>
    $$(`//button[@role='tab'][normalize-space()='${fileName}']`).length

  await openFileButton().waitForExist({ timeout: 30_000 })
  await browser.execute(
    ({ bytes, mockPath }: { bytes: number[]; mockPath: string }) => {
      const seam = window as unknown as Window & {
        __tfolioE2E?: E2eOverrides
        __tfolioE2EBytesPrior?: BytesOpenPrior
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: unknown) => Promise<unknown>
        }
      }

      seam.__tfolioE2EBytesPrior = {
        openPdfFromPath: seam.__tfolioE2E?.openPdfFromPath,
        pickPdfPath: seam.__tfolioE2E?.pickPdfPath,
      }
      seam.__tfolioE2E = {
        ...seam.__tfolioE2E,
        openPdfFromPath: () =>
          seam.__TAURI_INTERNALS__.invoke("open_pdf", new Uint8Array(bytes)),
        pickPdfPath: () => Promise.resolve(mockPath),
      }
    },
    { bytes: Array.from(contents), mockPath: `/e2e/${fileName}` },
  )

  // Counted before the click, so a tab already carrying the name cannot
  // pass for the new one and take the overrides off too early.
  const existingTabs = await tabsNamed()
  await openFileButton().click()
  await browser.waitUntil(async () => (await tabsNamed()) > existingTabs, {
    timeout: 30_000,
    timeoutMsg: "the byte-payload document never opened",
  })

  // The open consumed the pair. The keys go back to what they held before,
  // or a later picker-driven open on this page runs the stale byte payload.
  await browser.execute(() => {
    const page = window as Window & {
      __tfolioE2E?: E2eOverrides
      __tfolioE2EBytesPrior?: BytesOpenPrior
    }
    const prior = page.__tfolioE2EBytesPrior

    if (page.__tfolioE2E && prior) {
      if (prior.openPdfFromPath) {
        page.__tfolioE2E.openPdfFromPath = prior.openPdfFromPath
      } else {
        delete page.__tfolioE2E.openPdfFromPath
      }

      if (prior.pickPdfPath) {
        page.__tfolioE2E.pickPdfPath = prior.pickPdfPath
      } else {
        delete page.__tfolioE2E.pickPdfPath
      }
    }

    delete page.__tfolioE2EBytesPrior
  })
}

export async function clickOnPage(atX = 0.3, atY = 0.3) {
  await browser.execute(
    (at) => {
      const page = document.querySelector("[data-page-number='1']")!
      const canvas = page.querySelector("canvas")!
      const box = page.getBoundingClientRect()

      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          clientX: box.left + box.width * at.x,
          clientY: box.top + box.height * at.y,
          isPrimary: true,
        }),
      )
    },
    { x: atX, y: atY },
  )
}

/**
 * How much ink page 1 carries, read off the canvas pixels — PDFium can accept
 * and store a mark it then declines to draw, so only the canvas can vouch.
 */
export function pageInk(pageNumber = 1) {
  return browser.execute((targetPage: number) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `[data-page-number='${targetPage}'] canvas`,
    )!
    // A `bitmaprenderer` canvas has no 2d context to read: copy it into one.
    const copy = document.createElement("canvas")
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext("2d")!
    context.drawImage(canvas, 0, 0)
    const { data } = context.getImageData(0, 0, copy.width, copy.height)
    let ink = 0

    for (let index = 0; index < data.length; index += 4) {
      ink += 765 - data[index]! - data[index + 1]! - data[index + 2]!
    }

    return ink
  }, pageNumber)
}

/** A position-sensitive digest of page 1's pixels. */
export function pagePixelFingerprint(pageSelector = "[data-page-number='1']") {
  return browser.execute((selector: string) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `${selector} canvas`,
    )!
    // A `bitmaprenderer` canvas has no 2d context to read: copy it into one.
    const copy = document.createElement("canvas")
    copy.width = canvas.width
    copy.height = canvas.height
    const context = copy.getContext("2d")!
    context.drawImage(canvas, 0, 0)
    const { data } = context.getImageData(0, 0, copy.width, copy.height)
    let hash = 2166136261

    for (const value of data) {
      hash ^= value
      hash = Math.imul(hash, 16777619)
    }

    return hash >>> 0
  }, pageSelector)
}

export async function renderedPage(pageSelector = "[data-page-number='1']") {
  const page = await $(pageSelector)
  await page.waitForDisplayed({ timeout: 30_000 })

  const canvas = await page.$("canvas")
  // The canvas has a size before it contains any pixels.
  await expect(canvas).toHaveAttribute("data-rendered", "true", { wait: 30_000 })

  // A zoom-settling re-render (150ms debounce) can follow the first bitmap at
  // the same canvas size, so width alone cannot say the paint is final.
  await browser.pause(400)
  await browser.waitUntil(
    async () => {
      const first = await pagePixelFingerprint(pageSelector)
      await browser.pause(400)
      return (await pagePixelFingerprint(pageSelector)) === first
    },
    { timeout: 15_000, timeoutMsg: "page 1's paint never settled" },
  )
}

/**
 * WebDriver cannot start a desktop drag, so the event the window hears through
 * Tauri's event system is emitted directly, in CSS pixels (GTK logical units).
 */
export async function emitDrag(
  name: "drag-enter" | "drag-over" | "drag-drop" | "drag-leave",
  point: { x: number; y: number },
  paths: string[],
) {
  // The app binds its drop listeners a few IPC turns after it first paints, and
  // an event emitted before then reaches nobody: straight after a reload, on a
  // busy machine, that lost the whole drop.
  await $("html[data-file-drops]").waitForExist()

  return browser.execute(
    (event: string, x: number, y: number, files: string[]) => {
      const tauri = (
        window as Window & {
          __TAURI__?: {
            event: { emit: (name: string, payload: unknown) => Promise<void> }
          }
        }
      ).__TAURI__

      return tauri!.event.emit(`tauri://${event}`, {
        paths: files,
        position: { x: Math.round(x), y: Math.round(y) },
      })
    },
    name,
    point.x,
    point.y,
    paths,
  )
}
