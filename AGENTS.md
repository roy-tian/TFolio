# Repository Guidelines

TFolio is a PDF editor: a Tauri 2 desktop app with a React 19 + TypeScript
frontend (Vite, Tailwind v4, shadcn/ui, i18next) over a Rust backend that
renders PDFs with a bundled PDFium. `bun` is the package manager and runner.

## Layout

- `src/` — frontend. Primitives in `components/ui/`, helpers in `lib/`,
  translations in `i18n/locales/`.
- `src-tauri/src/` — Rust backend: `pdfium/` (engine, commands, geometry, font,
  watermark, page_numbers, outline, library), `recent.rs` (persisted recent
  files) and `preferences.rs` (the reader's own settings, in the app data
  directory).
- `src-tauri/tauri.conf.json` — app config and CSP; `tauri.e2e.conf.json`
  overlays the test-only build. `capabilities/` — Tauri permissions.
- `test/e2e/` — WebdriverIO GUI specs; `scripts/` — asset download, version,
  preflight.
- `.claude/skills/` holds symlinks only; skills live in `.agents/skills/`
  (`ln -s ../../.agents/skills/<name> .claude/skills/<name>`).
- Never commit: `dist/`, `src-tauri/target/`, `src-tauri/gen/`, `artifacts/`,
  `.temp/` (scratch), `src-tauri/resources/{pdfium,fonts}/*`.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run tauri:dev` | run the app with hot reload |
| `bun run build` | `tsc -b` + frontend production build |
| `bun run test` | frontend unit tests |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | Rust tests; add `-- --ignored` for the ones that need PDFium |
| `bun run test:e2e` | build the test binary, run the GUI suite headless (Xvfb) |
| `bun run test:all` | all three suites |
| `bun run preflight` | every single-platform CI check plus a local bundle |
| `bun run version:check` / `version:bump <patch\|minor\|major\|x.y.z>` | version across `package.json`, `bun.lock`, `Cargo.toml`, `Cargo.lock` |

`pdfium:download` and `fonts:download` fetch the pinned runtime assets and run
automatically before `tauri:dev|build|bundle`; without them the `#[ignore]` Rust
tests fail rather than skip. Before a PR run at least `bun run build`,
`bun run test`, `bun run version:check`, and the locked `cargo check` —
`test:all` for backend or GUI changes. Commit messages must be Conventional
Commits (commitlint runs on `commit-msg`).

## Style & tests

- TypeScript: two-space indent, double quotes, no semicolons; nothing enforces
  it, so match the surrounding code. Import via `@/`. Rust: `cargo fmt`.
- Add primitives with `bunx --bun shadcn@latest add <component>` so they match
  the pinned `base-nova` style; prefer registry variants over bespoke Tailwind.
- No hard-coded user-facing text: `useTranslation()`, plus the key in every
  locale. `en` defines the typed key schema, so gaps elsewhere fail the build.
- Frontend tests sit beside their modules as `*.test.ts(x)`.
- e2e specs cannot drive native dialogs (Tauri seals `invoke`), so they go
  through the app's own seam `window.__tfolioE2E` (`src/lib/e2e.ts`, set by
  `test/e2e/helpers.ts`), which is live only in the `e2e` Vite mode. Failures
  write screenshots and logs to `artifacts/e2e/`.

## Security & PDF invariants

Treat PDFs, annotations, metadata, and pasted content as untrusted. Parsing and
rendering happen only in Rust; bytes and rendered images cross IPC as raw binary
decoded via `createImageBitmap`, never as a `blob:` source.

- Keep the production CSP restrictive (`default-src 'self'`, no inline script or
  style, `object-src`/`frame-src` off). Extend it only with the specific scheme,
  host, or directive a feature needs, and keep relaxations in `devCsp`. No
  `dangerouslySetInnerHTML` without a sanitizer. Known benign violation: opening
  the settings select emits one `style-src-elem` (Base UI's scrollbar `<style>`);
  only *new* sources are regressions.
- Capabilities do **not** gate this app's own commands — everything in
  `generate_handler!` is callable by the WebView with any arguments, so validate
  in the command. Today: `export_pdf` takes a file *name*, reduced to
  `Path::file_name()`; `save_pdf` writes only to the `source_path` recorded at
  open; `open_pdf_from_path`, `merge_pdf_from_path`, `inspect_pdf_files` and
  `merge_pdf_files` act only on approved paths — ones the OS produced in Rust's
  sight (the drag-drop handler or a pick dialog, single or multi-select) —
  because opening a path binds it as what a later save overwrites, and reading
  one at all discloses its content. That check is `ensure_approved`, one wording
  for every call site. `recent.rs` records a path only after an approved open and
  re-approves at startup. The e2e build waives that check; nothing else does.
  `tauri-plugin-fs` is a transitive dependency and deliberately never registered.
- `delete_last_pdf_annotation` counts what the session added per page instead of
  trusting the frontend's undo history, so it can never delete a link, form
  field, or comment that was already in the reader's file.
- Watermarks are page content objects, not annotations, and `add_object()` only
  appends, so they render above page content. The app may replace or remove only
  the exact object tail it created in the current session; after a save and
  reopen those objects are input content. Never call them redaction or
  tamper-proofing. Because that ownership expires at close, a watermarked
  document may be written only to a *copy*: `save` refuses outright and
  `export_to` compares paths, and the watermark refusal resolves symlinks first
  (overwriting the original with a mark this app can no longer lift is
  unrecoverable; a dirty history is not). Any third write path needs the same
  guard.
- PDFium reads outlines but cannot write one, so the merge wizard's bookmark
  modes hand the bytes PDFium just saved to `outline.rs`, which writes
  `/Outlines` with lopdf and reopens the result. lopdf parses **only this app's
  own fresh output**, never a reader's file — keep it off the untrusted path, and
  keep PDFium the one parser an opened file meets.
- Security-related changes must pass `bun run build`, `bun run tauri:build`, and
  a manual WebView console check for unexpected CSP violations.

## Releases

`package.json` is the version source of truth; a `vX.Y.Z` tag must match it
exactly or the release workflow rejects it.
