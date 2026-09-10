// Shared fixtures and the file-open flow for every e2e suite.
//
// The app opens PDFs by filesystem path — a native dialog or a native drop —
// and WebDriver can drive neither. Nor can a test stub the IPC boundary:
// Tauri seals `__TAURI_INTERNALS__.invoke` (non-writable, non-configurable).
// Each opener below therefore fills in the app's own e2e seam
// (`window.__tfolioE2E`, read via `src/lib/e2e.ts` in e2e builds only) and
// then drives the real UI, so everything past the dialog really runs.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { $, browser } from "@wdio/globals"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { Settings } from "../../src/lib/settings"

/** Where the backend keeps this build's settings: the app data directory
    Tauri resolves for `com.roytian.tfolio.e2e` on the suite's one platform. */
const settingsFile = path.join(
  process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"),
  "com.roytian.tfolio.e2e",
  "settings.toml",
)

/**
 * A content-free PDF of `pageCount` pages, portrait unless `mediaBox` says
 * otherwise — pass a function of the 0-based page index for a document whose
 * pages are not all one size. Page objects take the odd ids from 3 up, each
 * followed by its (empty) contents stream.
 */
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

/**
 * A blank one-page PDF for the drawing suites: a rectangle or a note goes over
 * the page itself, so nothing needs to be underneath.
 */
export function blankPdf() {
  return minimalPdf(1, "0 0 300 400")
}

/**
 * `pageCount` pages, each carrying one black bar at a page-specific position,
 * so every page renders to a distinct fingerprint — which is what lets a
 * structure test say *which* page now sits where.
 */
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

/** A one-page drawing fixture with dense bars through its middle. */
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

/** Pages with one line of real text each, for selection and highlight tests. */
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

/** Two searchable pages: the first occurrence wraps between text lines and
 * the second uses different case on one line. */
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
 * Writes the settings the app boots on, straight into the file the backend
 * keeps — which is what makes them survive the `browser.refresh()` that has to
 * follow, the app reading them once before its first render.
 *
 * The whole document, replacing what was there: settings outlive a spec and
 * outlive the suite, so a spec that cares states everything it wants and
 * inherits nothing. What it does not name is unset, which is how a spec asks
 * for a default. `__TAURI__` is the e2e build's own global (`withGlobalTauri`),
 * and reading it is fine — only `__TAURI_INTERNALS__` is sealed.
 */
export async function seedSettings(settings: Settings = {}) {
  // The write goes through the backend, so it needs a page that has finished
  // booting; one still on its way there loses it when the app replaces it.
  // Waited for here rather than at each call site, because every call site is a
  // `browser.refresh()` away from exactly that.
  await openFileButton().waitForExist({ timeout: 30_000 })

  // The file rather than the page is what says the write landed, so the wait
  // below costs this fragile bridge no round trips at all — and it checks the
  // bytes the app will actually read back. Cleared first so that its being
  // there again is the signal.
  rmSync(settingsFile, { force: true })

  // As a string: the old seeding passed flat strings through this bridge for a
  // year without trouble, and there is no reason to be the first to hand it
  // something shaped differently. The promise stays in the page too — this
  // driver cannot serialise one back ("Unsupported result type").
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
      if (!existsSync(settingsFile)) {
        return false
      }

      // A half-written file simply fails the check and is polled again.
      const written = readFileSync(settingsFile, "utf8")

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
 * Reloads the app and waits out the reboot, which is how a settings change
 * gets applied. A stamp planted on the dying page is what the poll tells its
 * replacement from: a script that lands early reads the stamp back and waits
 * again, so it cannot vouch for a page the reload is about to discard. The
 * pause only keeps the first injection clear of the driver's teardown race —
 * a script the handoff loses waits out a hard 30s — and the 40s budget
 * absorbs one such hang and still comes back.
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

/** The home tab's drop zone, its own route to the native picker. It is in the
    page whichever tab is showing, so it doubles as the signal that the app has
    booted; it is only clickable while the home tab is the one on screen.
    By slot rather than label, which changes with the language. */
export function dropZoneButton() {
  return $("[data-slot='drop-zone']")
}

/** The tab strip's open-a-file button, which every tab shares. */
export function openFileButton() {
  return $("[data-slot='tab-open-file']")
}

/**
 * Hovers `selector`.
 *
 * WebKitGTK's embedded WebDriver moves the pointer without the WebView ever
 * seeing a hover, so the events Base UI listens for are dispatched in the page.
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

    // A pointer that never leaves would leave the last hint standing, and hints
    // outside one delay group do not close each other. Take the hover back
    // first, so the popup read below is the one this hover opened.
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

/** Whether the tooltip this trigger owns is up; others may be open too. */
export function tooltipOpen(selector: string) {
  return browser.execute(
    (css: string) =>
      document.querySelector(css)?.hasAttribute("data-popup-open") ?? false,
    selector,
  )
}

/** Hovers `selector` and answers with the text of the tooltip that opens. */
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
 * Opens the header's menu — where the file commands the toolbar has no key
 * for live — and hands back the item for `action`. The caller
 * either clicks it or reads it and presses Escape; `data-action` rather than
 * the label, which changes with the language.
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
 * Dismisses the menu and waits for its popup to actually leave the screen —
 * the next click would otherwise land on the closing popup, not the control
 * behind it. `item` is any element inside the menu, from `appMenuItem`.
 */
export async function closeAppMenu(
  item: Awaited<ReturnType<typeof appMenuItem>>,
) {
  await browser.keys("Escape")
  await item.waitForDisplayed({ reverse: true, timeout: 15_000 })
}

/**
 * Whether the menu currently offers `action`, leaving the menu closed again.
 * Base UI marks a disabled item with `data-disabled`, not the `disabled`
 * property WebdriverIO's `isEnabled` reads off a form control.
 */
export async function appMenuItemEnabled(action: string) {
  const item = await appMenuItem(action)
  const disabled = await item.getAttribute("data-disabled")
  await closeAppMenu(item)

  return disabled === null
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

/**
 * Points the app's picker seam at `filePath` and opens it from the tab strip,
 * which is on screen whatever is already open — so one helper serves the first
 * document and every later one alike.
 */
export async function openPathViaDialog(filePath: string) {
  // A refresh can resolve before the new page has booted; the strip's open
  // button appearing is what proves the seam lands on the page that reads it.
  await openFileButton().waitForExist({ timeout: 30_000 })
  await pointPickerAt(filePath)
  await openFileButton().click()
}

/**
 * Writes `contents` to a scratch file and hands back its path, without opening
 * it: the merge wizard and the grid's insert both read files they never open as
 * documents of their own.
 */
export function writeScratchPdf(fileName: string, contents: Uint8Array): string {
  const directory = mkdtempSync(path.join(tmpdir(), "tfolio-e2e-"))
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

/**
 * Opens `contents` as a document with no path at all, pointing the seam's
 * `openPdfFromPath` at the byte-payload `open_pdf` command — the documented
 * fallback for a document that never came from a file, which is the state the
 * save key's disabled case needs. Reading `__TAURI_INTERNALS__` is fine; only
 * writing it is sealed.
 */
export async function openPdfFromBytes(fileName: string, contents: Uint8Array) {
  await openFileButton().waitForExist({ timeout: 30_000 })
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
  await openFileButton().click()
}

/**
 * How much ink page 1 currently carries, read back off the canvas — the pixels
 * rather than the annotation the app thinks it added, because PDFium will
 * accept and store a mark it then declines to draw. Only the canvas can say
 * whether the reader can actually see it.
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

  // The first bitmap can be followed by a re-render once the viewer's zoom
  // settles (a 150ms debounce), often at the same canvas size — so the width
  // alone cannot say the paint is final. Two identical fingerprints a beat
  // apart say the repaint storm is over.
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
 * Emits the drag event the window's own handler listens for, standing in for a
 * drag from the desktop: WebDriver cannot start one, and the app hears these
 * through Tauri's event system rather than through DOM events. The position
 * goes over exactly as GTK reports one — in the window's own logical units,
 * which the suite's only platform makes the CSS pixels the page hit-tests with
 * (see the scaling note in `App.tsx`).
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

/** The middle of one thumbnail insert zone, in CSS pixels — where a dropped PDF
    would land at that position. */
export function gapPoint(index: number) {
  return browser.execute((at: number) => {
    const rect = document
      .querySelector(`[data-insert-index='${at}']`)!
      .getBoundingClientRect()

    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, index)
}
