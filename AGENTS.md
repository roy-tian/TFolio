# Repository Guidelines

TFolio is a PDF editor built as a Tauri 2 desktop app: a React 19 + TypeScript
frontend (Vite, Tailwind v4, shadcn/ui, i18next) over a Rust backend that parses
and renders PDFs with a bundled PDFium library. `bun` is the package manager and
task runner.

## Project Structure & Module Organization

- `src/`: frontend application code.
  - `src/components/`: reusable React components; shadcn-style primitives live
    under `src/components/ui/`.
  - `src/lib/`: shared, framework-agnostic helpers (e.g. `pdf.ts`).
  - `src/i18n/`: i18next setup and `src/i18n/locales/` translation resources.
  - `src/index.css`: global styles and Tailwind layer configuration.
  - `src/App.tsx`, `src/main.tsx`: application entry points.
- `src-tauri/src/`: Rust backend. `main.rs`/`lib.rs` are the entry points;
  `pdfium.rs` holds PDF parsing and rendering logic.
- `src-tauri/capabilities/`: Tauri permission definitions (`default.json`).
- `src-tauri/resources/`: bundled runtime assets, including the downloaded
  PDFium library under `resources/pdfium/`.
- `src-tauri/icons/`: desktop and mobile application icons.
- `src-tauri/tauri.conf.json`: main app config and CSP; `tauri.e2e.conf.json`
  overlays the test-only build.
- `scripts/`: maintenance scripts — `download-pdfium.mjs` (fetch the pinned
  PDFium runtime) and `version.mjs` (version sync/check).
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
  writes screenshots here), and `src-tauri/resources/pdfium/*` (kept out of git
  except `.gitkeep`).

## Build, Test, and Development Commands

- `bun install`: install frontend and Tauri CLI dependencies.
- `bun run tauri:dev`: run the desktop app with Vite hot reload (auto-downloads
  PDFium first).
- `bun run build`: type-check (`tsc -b`) and create the frontend production build.
- `bun run test`: run frontend unit tests with Bun's test runner.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: run Rust unit
  tests; append `-- --ignored` for tests that need the downloaded PDFium runtime.
- `bun run test:e2e`: build the test binary and run the GUI suite headless
  (requires Xvfb on Linux).
- `bun run test:all`: run frontend, Rust (incl. ignored), and GUI suites.
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`: validate Rust code
  against the committed lockfile.
- `bun run tauri:build`: build the optimized executable without installers.
- `bun run tauri:bundle`: create platform installers.
- `bun run pdfium:download`: fetch the pinned PDFium runtime for this platform
  (runs automatically before `tauri:dev`/`build`/`bundle`).
- `bun run version:check` / `bun run version:bump <patch|minor|major|x.y.z>`:
  verify or update the version across `package.json`, `bun.lock`, `Cargo.toml`,
  and `Cargo.lock`.

## Coding Style & Naming Conventions

TypeScript uses two-space indentation, double quotes, and no semicolons. Import
frontend modules via the `@/` alias (e.g. `@/lib/pdf`). Name React components in
PascalCase (`DocumentToolbar.tsx`), hooks with a `use` prefix, and helpers in
camelCase. Keep shadcn-style primitives under `src/components/ui/`. For Rust, run
`cargo fmt`; use snake_case for modules and functions and PascalCase for types.
Follow the existing trailing-comma style throughout.

Add primitives with `bunx --bun shadcn@latest add <component>` rather than
hand-writing them, so they match the `radix-nova` style pinned in
`components.json`. Prefer a registry component's built-in variants over bespoke
Tailwind: several already cover cases that look custom (e.g. `ToggleGroup` with
`variant="outline" spacing={0}` is a joined segmented control).

Do not hard-code user-facing text. Use `useTranslation()` and add keys to every
locale in `src/i18n/locales/`. English (`en`) defines the typed translation-key
schema, so missing or misspelled keys in other locales fail the build.

## Testing Guidelines

- Frontend unit tests use Bun's runner. Place them beside their modules as
  `*.test.ts(x)` (e.g. `src/lib/pdf.test.ts`); run with `bun run test`.
- Rust unit tests live in the relevant source file under `#[cfg(test)]`. Tests
  that render real PDFs are marked `#[ignore]` because they need the PDFium
  runtime — run them with `-- --ignored` after `bun run pdfium:download`, or set
  `PDFIUM_LIB_PATH` to point at a local library.
- GUI end-to-end tests drive a test-only Tauri binary through WebdriverIO's
  embedded WebDriver provider. The `e2e` Cargo feature, `e2e` capability, global
  Tauri API, and WDIO bridge are enabled only by `tauri.e2e.conf.json`; normal
  dev and release builds keep their CSP and capabilities unchanged. Failed runs
  write screenshots and logs under `artifacts/e2e/`.
- Before a pull request, run at minimum `bun run build`, `bun run test`,
  `bun run version:check`, and the locked `cargo check`. Prefer `bun run test:all`
  for changes touching the backend or GUI. Add focused tests for new behavior and
  avoid unrelated snapshot churn.

## Security & PDF Handling

Treat PDFs, annotations, metadata, rich text, pasted HTML, and remote content as
untrusted input. PDFs are parsed and rendered entirely in the Rust backend by the
bundled PDFium library; PDF bytes and rendered PNG pages cross the Tauri boundary
as raw binary IPC payloads and are never interpreted by the WebView.

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

Security-related changes must pass `bun run build`, `bun run tauri:build`, and a
manual check for unexpected CSP violations in the WebView developer console.

## Commit & Pull Request Guidelines

Use concise, imperative subjects with Conventional Commit prefixes (`feat:`,
`fix:`, `chore:`, `test:`, as seen in history). Keep each commit scoped to one
logical change.

Pull requests should explain the motivation, summarize implementation choices,
list the verification commands run, and link related issues. Include screenshots
or a short recording for visible UI changes.

`package.json` is the source of truth for the version. Use
`bun run version:bump <patch|minor|major|x.y.z>` to update all version files
together, then commit them. Do not push a release tag unless its `vX.Y.Z` value
exactly matches `package.json`; the release workflow rejects a mismatch before
creating assets.
