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

import { $, $$, browser } from "@wdio/globals"

import type { E2eOverrides } from "../../src/lib/e2e"
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
  const wanted = seededValues(settings)

  await browser.waitUntil(
    () => {
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
 * merge wizard and the grid's insert read files they never open.
 */
export function writeScratchPdf(fileName: string, contents: Uint8Array): string {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-e2e-"))
  scratchDirectories.push(directory)
  const filePath = path.join(directory, fileName)

  writeFileSync(filePath, contents)

  return filePath
}

/** The multi-select stand-in the merge wizard's add button reads, left beside
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

/**
 * How much ink page 1 carries, read off the canvas pixels — PDFium can accept
 * and store a mark it then declines to draw, so only the canvas can vouch.
 */
export function pageInk(pageNumber = 1) {
  return browser.execute((targetPage: number) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `[data-page-number='${targetPage}'] canvas`,
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
  }, pageNumber)
}

/** A position-sensitive digest of page 1's pixels. */
export function pagePixelFingerprint() {
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
    let hash = 2166136261

    for (const value of data) {
      hash ^= value
      hash = Math.imul(hash, 16777619)
    }

    return hash >>> 0
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

  // A zoom-settling re-render (150ms debounce) can follow the first bitmap at
  // the same canvas size, so width alone cannot say the paint is final.
  await browser.pause(400)
  await browser.waitUntil(
    async () => {
      const first = await pagePixelFingerprint()
      await browser.pause(400)
      return (await pagePixelFingerprint()) === first
    },
    { timeout: 15_000, timeoutMsg: "page 1's paint never settled" },
  )
}

/**
 * WebDriver cannot start a desktop drag, so the event the window hears through
 * Tauri's event system is emitted directly, in CSS pixels (GTK logical units).
 */
export function emitDrag(
  name: "drag-over" | "drag-drop",
  point: { x: number; y: number },
  paths: string[],
) {
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

export function gapPoint(index: number) {
  return browser.execute((at: number) => {
    const rect = document
      .querySelector(`[data-insert-index='${at}']`)!
      .getBoundingClientRect()

    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, index)
}
