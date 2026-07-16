# TFolio

TFolio is a PDF editor by Roy Tian, built with Rust, Tauri 2, React 19, and
shadcn/ui. PDFs are parsed and rendered entirely in a Rust backend by a locally
bundled PDFium library, so document content is never interpreted by the WebView.

## Features

- Open PDFs by drag-and-drop or the file picker (up to 512 MB).
- Continuous vertical page view with pages rendered natively and lazily.
- Page indicator with jump-to-page input, plus automatic tracking of the page
  you are reading.
- Bookmark sidebar built from the document outline (table of contents) for
  quick navigation.
- Simplified Chinese and English UI that follows your saved preference, then the
  operating-system language.
- Adapts to light and dark system themes.

## Tech stack

- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS v4, shadcn/ui,
  i18next.
- **Backend:** Rust via Tauri 2, with `pdfium-render` for PDF parsing and page
  rendering.
- **Tooling:** Bun (package manager and task runner), WebdriverIO for GUI
  end-to-end tests.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer.
- A stable [Rust](https://www.rust-lang.org/tools/install) toolchain.
- Platform build dependencies for Tauri 2 — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Debian or
  Ubuntu:

  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
  ```

  Add `xvfb` as well if you plan to run the GUI end-to-end tests headless.

## Development

```bash
bun install
bun run tauri:dev
```

`tauri:dev` automatically downloads the pinned PDFium runtime for your platform
before starting Vite with hot reload.

## Project layout

- `src/` — React frontend. Reusable components in `src/components/` (shadcn
  primitives under `src/components/ui/`), shared helpers in `src/lib/`, and
  internationalization in `src/i18n/`.
- `src-tauri/src/` — Rust backend; `pdfium.rs` holds PDF parsing and rendering,
  exposed to the frontend as the `open_pdf`, `render_pdf_page`, and `close_pdf`
  commands.
- `scripts/` — maintenance scripts (`download-pdfium.mjs`, `version.mjs`).
- `test/e2e/` — WebdriverIO GUI end-to-end specs.

See [AGENTS.md](AGENTS.md) for the full contributor and coding guidelines.

## Testing

- Frontend unit tests (Bun's test runner), including the locale-selection tests:

  ```bash
  bun run test
  ```

- Rust unit tests. Tests that render real PDFs are marked `#[ignore]` because
  they need the PDFium runtime — download it first, then include ignored tests:

  ```bash
  bun run pdfium:download
  cargo test --manifest-path src-tauri/Cargo.toml --locked
  cargo test --manifest-path src-tauri/Cargo.toml --locked -- --ignored
  ```

- Run the frontend, Rust (including ignored), and GUI suites together:

  ```bash
  bun run test:all
  ```

### GUI end-to-end tests

The GUI suite drives a test-only Tauri binary through WebdriverIO's embedded
WebDriver provider. The `e2e` Cargo feature, `e2e` capability, global Tauri API,
and frontend WDIO bridge are enabled only by `src-tauri/tauri.e2e.conf.json`;
normal development and release builds keep their CSP and default capability set
unchanged.

Build the test binary and run the suite under a virtual display (requires
`xvfb` on Linux):

```bash
bun run test:e2e
```

For iteration, the build and run steps can be invoked separately:

```bash
bun run test:e2e:build
bun run test:e2e:headless
```

Failed tests write screenshots and WebdriverIO logs under `artifacts/e2e/`.

## Internationalization

The UI supports Simplified Chinese (`zh-CN`) and English (`en`). Language
selection follows the saved preference first, then the operating-system
languages, and defaults to Simplified Chinese. English is the fallback for any
missing translation key and defines the typed translation-key schema, so other
locales are checked for missing or misspelled keys at build time.

Use `useTranslation()` in React components instead of hard-coding user-facing
text. To add a locale, create a file under `src/i18n/locales/`, register it in
the `resources` map in `src/i18n/index.ts`, and add its code to
`supportedLanguages` (with a matching case in `resolveSupportedLanguage`) in
`src/i18n/config.ts`. Expose language controls only when the product UI calls
for them.

## PDF security

PDF files are parsed and rendered in the Rust backend by a locally bundled
PDFium library. PDF bytes and rendered PNG pages cross the Tauri boundary as raw
binary IPC payloads; PDF content is never interpreted by the WebView. The
production Content Security Policy only permits same-origin application resources
and Tauri IPC. The development-only CSP permits inline styles solely because
Vite's CSS hot reload injects styles at runtime; production does not allow inline
styles.

`bun run tauri:dev`, `bun run tauri:build`, and `bun run tauri:bundle`
automatically download the pinned PDFium runtime for the current platform. To
prepare it explicitly, run `bun run pdfium:download`. Set `PDFIUM_LIB_PATH` to
use a local PDFium library instead.

## Build the executable

```bash
bun run tauri:build
```

The optimized executable is written to `src-tauri/target/release/` (`tfolio` on
Linux and macOS, `tfolio.exe` on Windows).

## Build installers

```bash
bun run tauri:bundle
```

## Versioning

`package.json` is the source of truth for the application version. Tauri reads it
directly, while the version command keeps `bun.lock`, `Cargo.toml`, and
`Cargo.lock` in sync.

Use a semantic version or an increment name:

```bash
bun run version:bump patch
bun run version:bump minor
bun run version:bump major
bun run version:bump 1.2.3
```

Review the changed files and verify them before committing:

```bash
bun run version:check
```

## Continuous integration

The CI workflow runs on pushes to `master` and topic branches, and on every
pull request. It has three jobs:

- **Frontend** — checks version sync (`version:check`), runs `bun run test`, and
  builds the frontend.
- **Rust** — checks formatting (`cargo fmt --check`), lints with Clippy (warnings
  denied), and runs `cargo check` and `cargo test` against the locked lockfile.
- **GUI E2E** — builds the test binary, exercises the ignored PDFium integration
  test, and runs the WebdriverIO suite under Xvfb, uploading `artifacts/e2e/` on
  failure.

## GitHub release

The release workflow builds installers for macOS (Apple Silicon and Intel),
Linux x64, and Windows x64. A pushed `vX.Y.Z` tag validates the version, creates
a GitHub Release with generated notes, and uploads all platform bundles.
Pre-release SemVer tags such as `v1.2.3-rc.1` are published as GitHub
pre-releases.

Create a release from the commit that contains the matching version change:

```bash
bun run version:bump patch
git add package.json bun.lock src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin HEAD
git push origin v0.1.1
```

The tag and `package.json` version must match exactly. For example, tag `v0.1.1`
must point to a commit whose package version is `0.1.1`; the workflow rejects a
mismatch before creating release assets.

## License

TFolio is available under the [MIT License](LICENSE).
