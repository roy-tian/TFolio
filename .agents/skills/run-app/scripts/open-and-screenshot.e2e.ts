// Reusable wdio spec for the `run-app` skill.
//
// Launches the app through the embedded WebDriver bridge (the e2e Cargo build),
// optionally opens a PDF, and saves a screenshot of the WebView.
//
// Driven entirely by env vars so it can be pointed at any file without editing:
//   TFOLIO_PDF   absolute path to a PDF to open (unset/empty => screenshot the
//                empty drop-zone state instead)
//   TFOLIO_SHOT  output PNG path (default: artifacts/run/screenshot.png)
//   TFOLIO_LANG  "zh-CN" (default) or "en" — UI language for the screenshot
//   TFOLIO_VIEW  "single" (default), "book", or "thumbnail" — view mode
//
// Run with:
//   xvfb-run -a bunx wdio run wdio.conf.ts \
//     --spec .agents/skills/run-app/open-and-screenshot.e2e.ts
// (with the WebKit software-render env vars from SKILL.md exported).

import { mkdirSync } from "node:fs"
import path from "node:path"

import { $, browser } from "@wdio/globals"
import "@wdio/tauri-service"

// Hardcoded so this file is location-independent (no import from ../../src).
// Keep in sync with src/i18n/config.ts and src/lib/viewMode.ts.
const languageStorageKey = "tfolio.ui.language"
const viewModeStorageKey = "tfolio.ui.viewMode"

const pdfPath = process.env.TFOLIO_PDF?.trim()
const shotPath = path.resolve(
  process.env.TFOLIO_SHOT?.trim() || "artifacts/run/screenshot.png",
)
const language = process.env.TFOLIO_LANG?.trim() || "zh-CN"
const viewMode = process.env.TFOLIO_VIEW?.trim() || "single"

// The app opens PDFs by filesystem path through a native dialog WebDriver
// cannot drive. The PDF is already a file on disk here, so the app's e2e seam
// (`window.__tfolioE2E`, live in e2e builds only — see src/lib/e2e.ts) only
// has to answer the picker with its path; `open_pdf_from_path` then really
// runs. Keep in sync with test/e2e/helpers.ts (`openPathViaDialog`).
async function selectPdf(filePath: string) {
  await browser.execute((mockPath: string) => {
    ;(
      window as Window & {
        __tfolioE2E?: { pickPdfPath?: () => Promise<string | null> }
      }
    ).__tfolioE2E = {
      pickPdfPath: () => Promise.resolve(mockPath),
    }
  }, filePath)
  await $("[data-slot='drop-zone']").click()
}

describe("run-app: launch and screenshot", () => {
  it("captures the app UI", async () => {
    // Both of these persist across runs (see SKILL.md), so set them explicitly
    // rather than inheriting whatever the last run happened to leave behind.
    await browser.execute(
      ({ langKey, lang, viewKey, view }) => {
        window.localStorage.setItem(langKey, lang)
        window.localStorage.setItem(viewKey, view)
      },
      {
        lang: language,
        langKey: languageStorageKey,
        view: viewMode,
        viewKey: viewModeStorageKey,
      },
    )
    await browser.refresh()
    await $("[data-slot='drop-zone']").waitForExist({ timeout: 30_000 })

    if (pdfPath) {
      await selectPdf(path.resolve(pdfPath))

      const firstPage = await $("[data-page-number='1']")
      await firstPage.waitForDisplayed({ timeout: 30_000 })

      // The canvas starts as a 1px placeholder and gets its real width once the
      // page object loads. Thumbnails size it to THUMBNAIL_WIDTH (160) while
      // full pages are far wider, so the bar has to clear both — the `pause`
      // below, not this wait, is what covers the PDFium paint.
      const canvas = await firstPage.$("canvas")
      await browser.waitUntil(
        async () => Number(await canvas.getAttribute("width")) > 100,
        {
          timeout: 30_000,
          timeoutMsg: "PDF page 1 never got its dimensions from the document",
        },
      )
      // Let the rendered page bitmap paint into the viewport before capturing.
      await browser.pause(3500)
    } else {
      // Empty state: give the drop zone a beat to settle.
      await browser.pause(500)
    }

    mkdirSync(path.dirname(shotPath), { recursive: true })
    await browser.saveScreenshot(shotPath)
    // eslint-disable-next-line no-console
    console.log(`run-app screenshot saved to ${shotPath}`)
  })
})
