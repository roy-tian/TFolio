// Shared fixtures and the file-open flow for every e2e suite.
//
// The app opens PDFs by filesystem path — a native dialog or a native drop —
// and WebDriver can drive neither. Nor can a test stub the IPC boundary:
// Tauri seals `__TAURI_INTERNALS__.invoke` (non-writable, non-configurable).
// Each opener below therefore fills in the app's own e2e seam
// (`window.__tfolioE2E`, read via `src/lib/e2e.ts` in e2e builds only) and
// then drives the real UI, so everything past the dialog really runs.

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { $, browser } from "@wdio/globals"

import type { E2eOverrides } from "../../src/lib/e2e"

/**
 * A content-free PDF of `pageCount` pages, portrait unless `mediaBox` says
 * otherwise. Page objects take the odd ids from 3 up, each followed by its
 * (empty) contents stream.
 */
export function minimalPdf(pageCount = 1, mediaBox = "0 0 200 300") {
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

  return buildPdf(objects)
}

/**
 * A blank one-page PDF for the drawing suites: a rectangle or a note goes over
 * the page itself, so nothing needs to be underneath.
 */
export function blankPdf() {
  return minimalPdf(1, "0 0 300 400")
}

/**
 * A one-page PDF with a line of real text, so there is something to select and
 * something for a highlight to sit over.
 */
export function textPdf() {
  const content = "BT\n/F1 24 Tf\n40 200 Td\n(Highlight me please) Tj\nET\n"

  return buildPdf([
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ])
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

/** The drop zone's button to the native picker, present while no document is.
    By slot rather than label (which changes with the language) or structure
    (`main` fills with a button per thumbnail once a document opens). */
export function dropZoneButton() {
  return $("[data-slot='drop-zone']")
}

/**
 * Writes `contents` to a scratch file and opens it through the app's real
 * choose-a-file flow — only the native dialog is stubbed, resolving with the
 * file's path — then returns that path, which is where a save will land.
 */
export async function openPdfFromDisk(
  fileName: string,
  contents: Uint8Array,
): Promise<string> {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-e2e-"))
  const filePath = path.join(directory, fileName)
  writeFileSync(filePath, contents)
  await openPathViaDialog(filePath)

  return filePath
}

/** Points the app's picker seam at `filePath` and clicks the drop zone. */
export async function openPathViaDialog(filePath: string) {
  // A refresh can resolve before the new page has booted; the drop zone
  // appearing is what proves the seam lands on the page that will read it.
  await dropZoneButton().waitForExist({ timeout: 30_000 })
  await browser.execute((mockPath: string) => {
    const seam = window as Window & { __tfolioE2E?: E2eOverrides }

    seam.__tfolioE2E = {
      pickPdfPath: () => Promise.resolve(mockPath),
    }
  }, filePath)
  await dropZoneButton().click()
}

/**
 * Opens `contents` as a document with no path at all, pointing the seam's
 * `openPdfFromPath` at the byte-payload `open_pdf` command — the documented
 * fallback for a document that never came from a file, which is the state the
 * save key's disabled case needs. Reading `__TAURI_INTERNALS__` is fine; only
 * writing it is sealed.
 */
export async function openPdfFromBytes(fileName: string, contents: Uint8Array) {
  await dropZoneButton().waitForExist({ timeout: 30_000 })
  await browser.execute(
    ({ bytes, mockPath }: { bytes: number[]; mockPath: string }) => {
      const seam = window as unknown as Window & {
        __tfolioE2E?: E2eOverrides
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: unknown) => Promise<unknown>
        }
      }

      seam.__tfolioE2E = {
        openPdfFromPath: () =>
          seam.__TAURI_INTERNALS__.invoke("open_pdf", new Uint8Array(bytes)),
        pickPdfPath: () => Promise.resolve(mockPath),
      }
    },
    { bytes: Array.from(contents), mockPath: `/e2e/${fileName}` },
  )
  await dropZoneButton().click()
}

/**
 * How much ink page 1 currently carries, read back off the canvas — the pixels
 * rather than the annotation the app thinks it added, because PDFium will
 * accept and store a mark it then declines to draw. Only the canvas can say
 * whether the reader can actually see it.
 */
export function pageInk() {
  return browser.execute(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "[data-page-number='1'] canvas",
    )!
    const { data } = canvas.getContext("2d")!.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    )
    let ink = 0

    for (let index = 0; index < data.length; index += 4) {
      ink += 765 - data[index]! - data[index + 1]! - data[index + 2]!
    }

    return ink
  })
}

export async function renderedPage() {
  const page = await $("[data-page-number='1']")
  await page.waitForDisplayed({ timeout: 30_000 })

  const canvas = await page.$("canvas")
  await browser.waitUntil(
    async () => Number(await canvas.getAttribute("width")) > 200,
    { timeout: 30_000, timeoutMsg: "page 1 never finished rendering" },
  )
  await browser.pause(1500)
}
