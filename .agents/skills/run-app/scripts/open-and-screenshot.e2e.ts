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

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { $, browser } from "@wdio/globals"
import "@wdio/tauri-service"

const pdfPath = process.env.TFOLIO_PDF?.trim()
const shotPath = path.resolve(
  process.env.TFOLIO_SHOT?.trim() || "artifacts/run/screenshot.png",
)
/** Where the backend keeps this build's settings: the app data directory
    Tauri resolves for `com.roytian.tfolio.e2e` on this suite's one platform.
    Keep in sync with test/e2e/helpers.ts (`seedSettings`). */
const settingsFile = path.join(
  process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"),
  "com.roytian.tfolio.e2e",
  "settings.toml",
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
    // They go to the backend that keeps `settings.toml`, which is what makes
    // them survive the refresh the app needs to read them.
    // Keep in sync with test/e2e/helpers.ts (`seedSettings`).
    rmSync(settingsFile, { force: true })
    await browser.execute((json: string) => {
      const tauri = (
        window as Window & {
          __TAURI__?: {
            core: {
              invoke: (command: string, args?: unknown) => Promise<unknown>
            }
          }
        }
      ).__TAURI__

      // The promise stays in the page: this driver cannot serialise one back.
      void tauri?.core.invoke("set_settings", {
        settings: JSON.parse(json) as unknown,
      })
    }, JSON.stringify({ ui: { language, viewMode } }))

    // The file rather than the page is what says the write landed, and holding
    // both values is what tells it from whatever was there before.
    await browser.waitUntil(
      () =>
        existsSync(settingsFile) &&
        [language, viewMode].every((value) =>
          readFileSync(settingsFile, "utf8").includes(value),
        ),
      { timeout: 15_000, timeoutMsg: "the settings never reached the backend" },
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
