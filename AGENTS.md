# Repository Guidelines

TFolio is a PDF editor built as a Tauri 2 desktop app: a React 19 + TypeScript
frontend (Vite, Tailwind v4, shadcn/ui, i18next) over a Rust backend that parses
and renders PDFs with a bundled PDFium library. `bun` is the package manager and
task runner.

## Project Structure & Module Organization

- `src/`: frontend application code.
  - `src/components/`: reusable React components; shadcn-style primitives live
    under `src/components/ui/`.
  - `src/hooks/`: reusable React hooks (e.g. `useNearViewport.ts`).
  - `src/lib/`: shared, framework-agnostic helpers (e.g. `pdf.ts`).
  - `src/i18n/`: i18next setup and `src/i18n/locales/` translation resources.
  - `src/index.css`: global styles and Tailwind layer configuration.
  - `src/App.tsx`, `src/main.tsx`: application entry points.
- `src-tauri/src/`: Rust backend. `main.rs`/`lib.rs` are the entry points;
  `pdfium/` holds PDF parsing and rendering — `engine.rs` (documents and
  annotations), `commands.rs` (the Tauri commands), `geometry.rs` (coordinates
  and the style ranges), `font.rs` (the bundled CJK face and per-note
  subsetting), `library.rs` (binding the PDFium runtime).
- `src-tauri/capabilities/`: Tauri permission definitions (`default.json`).
- `src-tauri/resources/`: bundled runtime assets — the downloaded PDFium
  library under `resources/pdfium/` and the Noto Sans SC face text notes subset
  from under `resources/fonts/`.
- `src-tauri/icons/`: desktop and mobile application icons.
- `src-tauri/tauri.conf.json`: main app config and CSP; `tauri.e2e.conf.json`
  overlays the test-only build.
- `scripts/`: maintenance scripts — `download-pdfium.mjs` (fetch the pinned
  PDFium runtime), `download-fonts.mjs` (fetch the pinned Noto Sans SC), and
  `version.mjs` (version sync/check).
- `test/e2e/`: WebdriverIO GUI end-to-end specs (`*.e2e.ts`).
- `.github/workflows/`: GitHub Actions release automation.
- `.agents/skills/`: the single home for every agent skill, committed so each
  contributor's agent behaves the same. It holds both this repo's own skills
  (`run-app`) and ones vendored from upstream registries (`shadcn`, pinned by
  `skills-lock.json` — manage those with `bunx --bun skills add|update|list`,
  and do not hand-edit them). The directory is tool-neutral, so Codex, Copilot,
  Zed, and others read the same skills.
- `.claude/skills/`: symlinks into `.agents/skills/`, nothing else. Claude Code
  only discovers skills under `.claude/skills/`, so each skill needs a link here
  to load; store the skill itself in `.agents/skills/`. Add one with
  `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
- Generated / do not commit: `dist/`, `node_modules/`, `src-tauri/target/`,
  `src-tauri/gen/`, `artifacts/`, `.temp/` (local scratch; the `run-app` skill
  writes screenshots here), and `src-tauri/resources/pdfium/*` plus
  `src-tauri/resources/fonts/*` (both kept out of git except `.gitkeep`).

## Build, Test, and Development Commands

- `bun install`: install frontend and Tauri CLI dependencies.
- `bun run tauri:dev`: run the desktop app with Vite hot reload (auto-downloads
  PDFium first).
- `bun run build`: type-check (`tsc -b`) and create the frontend production build.
- `bun run test`: run frontend unit tests with Bun's test runner.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: run Rust unit tests.
- `bun run test:e2e`: build the test binary and run the GUI suite headless
  (requires Xvfb on Linux).
- `bun run test:all`: run frontend, Rust (incl. ignored), and GUI suites.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`: validate Rust code
  against the committed lockfile.
- `bun run tauri:build`: build the optimized executable without installers.
- `bun run tauri:bundle`: create platform installers.
- `bun run pdfium:download`: fetch the pinned PDFium runtime for this platform
  (runs automatically before `tauri:dev`/`build`/`bundle`).
- `bun run fonts:download`: fetch the pinned Noto Sans SC used by text notes
  (runs alongside `pdfium:download`). The `#[ignore]` Rust tests that write a
  Chinese note need it, and without it they fail rather than skip.
- `bun run version:check` / `bun run version:bump <patch|minor|major|x.y.z>`:
  verify or update the version across `package.json`, `bun.lock`, `Cargo.toml`,
  and `Cargo.lock`.

## Coding Style & Naming Conventions

TypeScript uses two-space indentation, double quotes, and no semicolons; no
formatter enforces this, so match the surrounding code. Import frontend modules
via the `@/` alias (e.g. `@/lib/pdf`). For Rust, run `cargo fmt`.

Add primitives with `bunx --bun shadcn@latest add <component>` rather than
hand-writing them, so they match the `base-nova` style pinned in
`components.json`. Prefer a registry component's built-in variants over bespoke
Tailwind: several already cover cases that look custom (e.g. `ToggleGroup` with
`variant="outline" spacing={0}` is a joined segmented control).

Do not hard-code user-facing text. Use `useTranslation()` and add keys to every
locale in `src/i18n/locales/`. English (`en`) defines the typed translation-key
schema, so missing or misspelled keys in other locales fail the build.

## Testing Guidelines

- Place frontend unit tests beside their modules as `*.test.ts(x)` (e.g.
  `src/lib/pdf.test.ts`).
- Rust tests that render real PDFs are marked `#[ignore]` because they need the
  PDFium runtime — run them with `-- --ignored` after `bun run pdfium:download`,
  or set `PDFIUM_LIB_PATH` to point at a local library.
- GUI end-to-end tests drive a test-only Tauri binary through WebdriverIO's
  embedded WebDriver provider. The `e2e` Cargo feature, `e2e` capability, global
  Tauri API, and WDIO bridge are enabled only by `tauri.e2e.conf.json`; normal
  dev and release builds keep their CSP and capabilities unchanged. Failed runs
  write screenshots and logs under `artifacts/e2e/`. WebDriver cannot drive
  native file dialogs, and Tauri seals `__TAURI_INTERNALS__.invoke`
  (non-writable), so specs stand in for the pickers through the app's own seam
  — `window.__tfolioE2E`, read via `src/lib/e2e.ts` and set by
  `test/e2e/helpers.ts` — which is live only in the `e2e` Vite mode and dead
  code in every other build.
- Before a pull request, run at minimum `bun run build`, `bun run test`,
  `bun run version:check`, and the locked `cargo check`. Prefer `bun run test:all`
  for changes touching the backend or GUI.

## Security & PDF Handling

Treat PDFs, annotations, metadata, rich text, pasted HTML, and remote content as
untrusted input. PDFs are parsed and rendered entirely in the Rust backend by the
bundled PDFium library; PDF bytes and rendered pages (PNG for pages, WebP for
thumbnails) cross the Tauri boundary as raw binary IPC payloads, and are decoded
straight to a bitmap via `createImageBitmap`, never as a document-attached
`blob:` source.

The production CSP (`app.security.csp` in `tauri.conf.json`) is intentionally
restrictive — `default-src 'self'`, no inline scripts or styles, `object-src`
and `frame-src` disabled — and a separate `devCsp` permits only the WebSocket and
`'unsafe-inline'` styles that Vite HMR needs. Preserve this posture:

- Extend the CSP from `'self'`; add only the specific schemes, hosts, and
  directives a feature requires. Never introduce wildcard sources,
  `'unsafe-eval'`, or `'unsafe-inline'` in production without a documented
  technical requirement, and keep any relaxation in `devCsp` only.
- Keep `object-src` and `frame-src` disabled unless embedding demands them.
- When adding PDF workers, WebAssembly, blob URLs, the asset protocol, or
  `convertFileSrc`, allow `blob:`, `'wasm-unsafe-eval'`, `asset:`, or
  `http://asset.localhost` only in the directives that need them.
- Never render untrusted HTML with `dangerouslySetInnerHTML` without a sanitizer.
- Review CSP and Tauri capabilities together; grant filesystem, dialog, shell,
  and protocol permissions with the narrowest practical scopes.

The capability list is **not** what gates this app's own commands. Tauri's ACL
covers plugin and core commands only; anything in `generate_handler!` is callable
by the WebView with whatever arguments it likes, which is why none of the PDF
commands needed a permission entry to work. `capabilities/default.json` grants
no dialog permissions at all: both file dialogs live in Rust commands
(`pick_pdf_path` and `export_pdf`, via `blocking_pick_file`/`blocking_save_file`
in `spawn_blocking`), so no destination or source path is ever *chosen* by the
WebView. What the WebView may pass is checked in the command: `export_pdf`
accepts only a suggested file *name*, reduced to `Path::file_name()` before it
reaches the dialog; `save_pdf` writes only to the `source_path` recorded at
open; and `open_pdf_from_path` — which drag-drop needs, since Tauri hands drop
paths to the frontend — acts only on *approved* paths, ones the OS produced in
Rust's sight (the window's own drag-drop event handler in `lib.rs`, or the pick
dialog), because opening a path is what binds it as the file a save will later
overwrite. The e2e build waives that approval check (its scratch files never
saw a dialog); nothing else does. Besides `core:default` the capability holds
only `core:window:allow-destroy`, which the unsaved-changes close guard needs
to actually close the window once the reader confirms. The principle stands: an
argument a command will act on has to be checked in the command, not assumed
safe because a dialog produced it. `tauri-plugin-dialog` pulls `tauri-plugin-fs`
in as a transitive dependency; it is deliberately never registered, so no `fs`
commands are exposed — do not read its presence in `Cargo.lock` as permission
to use it.

The backend enforces its own invariants for the same reason. `delete_last_pdf_annotation`
counts what the session added to each page and refuses to go past it, rather than
trusting the frontend's undo history: a real PDF's pages carry links, form
fields, and comments, and an undo that ran off the end of the reader's own marks
would delete one of those permanently and save it into their file.

Security-related changes must pass `bun run build`, `bun run tauri:build`, and a
manual check for unexpected CSP violations in the WebView developer console.

Known benign CSP violation: opening the settings select emits exactly one
`style-src-elem` "inline" violation. Base UI hides the popup list's scrollbar
via `styleDisableScrollbar`, a `<style>` element React hoists into `<head>` —
blocked by the production `style-src 'self'`, and expected. It is cosmetic: the
rule would only suppress a scrollbar the two-item language list never grows.
Base UI's `CSPProvider` can supply a nonce if that ever stops being true. Opening
the dialog itself is clean. React `style={{…}}` props, popup positioning, and
`element.style` writes (e.g. `colorScheme`) go through the CSSOM, which CSP does
not govern. Treat only *new* violation sources as regressions during the manual
console check.

## Versioning & Releases

`package.json` is the source of truth for the version. Do not push a release tag
unless its `vX.Y.Z` value exactly matches it; the release workflow rejects a
mismatch before creating assets.
