# Repository Guidelines

TFolio is a PDF editor: Tauri 2 shell, React 19 + TypeScript frontend (Vite,
Tailwind v4, shadcn/ui, i18next), Rust backend rendering with a bundled PDFium.
`bun` runs everything.

## Layout

- `src/` — `components/ui/` (shadcn primitives), `hooks/`, `lib/` (framework-free
  logic, unit-tested), `i18n/locales/`.
- `src-tauri/src/` — `pdfium/` (engine, commands, geometry, font, watermark,
  page_numbers, outline, library), `recent.rs`, `preferences.rs`.
- `src-tauri/tauri.conf.json` — config and CSP; `tauri.e2e.conf.json` overlays
  the test-only build. `capabilities/` — Tauri permissions.
- `test/e2e/` — WebdriverIO specs; `scripts/` — asset download, version,
  preflight.
- Tooling writes only under `artifacts/<tool>/` (`e2e/`, `run/`), so
  `rm -rf artifacts/` resets cleanly; `.temp/` holds hand-placed fixtures.
- Skills live in `.agents/skills/`; `.claude/skills/` holds only symlinks
  (`ln -s ../../.agents/skills/<name> .claude/skills/<name>`).

## Commands

| Command | Purpose |
| --- | --- |
| `bun run tauri:dev` | run the app with hot reload |
| `bun run build` | `tsc -b` + frontend production build |
| `bun run test` | frontend unit tests |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | Rust tests; `-- --ignored` for the ones needing PDFium |
| `bun run test:e2e` | build the test binary, run the GUI suite headless (Xvfb) |
| `bun run test:all` | all three suites |
| `bun run preflight` | every single-platform CI check plus a local bundle |
| `bun run version:check` / `version:bump <patch\|minor\|major\|x.y.z>` | version across `package.json`, `bun.lock`, `Cargo.toml`, `Cargo.lock` |

`pdfium:download` runs automatically before `tauri:dev|build|bundle`. Fonts are
**not** bundled: `fonts:download` is run by the test scripts only, and without it
the `#[ignore]` Rust tests fail, not skip. At runtime a note or watermark that
leaves Latin-1 takes the system's own sans, and only where nothing installed can
draw it does the app offer to fetch one (see below).

CI gates, all required before a PR: `bun run build`, `bun run test`,
`bun run version:check`, and against `src-tauri/Cargo.toml` —
`cargo fmt -- --check`, `cargo clippy --locked -- -D warnings`,
`cargo check --locked`. Add `test:all` for backend or GUI changes. Conventional
Commits enforced by commitlint on `commit-msg`.

## Style & tests

- Nothing lints or formats the TypeScript: two-space indent, double quotes, no
  semicolons — match the surrounding code. Import via `@/`. Rust: `cargo fmt`.
- New primitives: `bunx --bun shadcn@latest add <component>` (pinned
  `base-nova`); prefer registry variants over bespoke Tailwind.
- No hard-coded user-facing text — `useTranslation()`, key in every locale. `en`
  is the typed schema; gaps in `zh-CN` fail the build.
- Frontend tests sit beside their modules as `*.test.ts(x)`.
- e2e specs cannot drive native dialogs (Tauri seals `invoke`); they use the seam
  `window.__tfolioE2E` (`src/lib/e2e.ts`, set by `test/e2e/helpers.ts`), live only
  in `e2e` Vite mode. Failures land in `artifacts/e2e/`, wiped at each run.

## Security & PDF invariants

Parsing and rendering happen only in Rust; bytes and images cross IPC as raw
binary decoded via `createImageBitmap`, never as a `blob:` source.

- CSP stays restrictive (`default-src 'self'`, no inline script or style,
  `object-src`/`frame-src` `'none'`); relaxations only in `devCsp`. No
  `dangerouslySetInnerHTML` without a sanitizer. One known benign violation — the
  settings select's `style-src-elem` (Base UI); only *new* sources regress.
- Capabilities do **not** gate this app's commands — everything in
  `generate_handler!` is callable by the WebView with any arguments, so validate
  in the command:
  - `export_pdf` takes a name, reduced to `Path::file_name()`; `save_pdf` writes
    only to the `source_path` recorded at open.
  - `open_pdf_from_path`, `insert_pdf_from_path`, `inspect_pdf_files`,
    `merge_pdf_files` accept only paths the OS produced in Rust's sight (drop
    handler, `pick_pdf_path(s)`) — a path binds what a later save overwrites, and
    reading one discloses its content. One check, `ensure_approved`, waived only
    in the e2e build; `recent.rs` stores approved opens, re-approved at startup.
  - `insert_pdf_from_path` validates its position in the engine, not the command,
    so the e2e build checks it too: an out-of-range index is refused, not clamped.
  - `tauri-plugin-fs` is transitive and deliberately never registered.
- `download_pdf_note_font` is the app's only outbound request. It takes no
  argument the WebView could shape — host, pinned commit, size, SHA-256 and
  destination all live in `font.rs` — so it can fetch exactly one file to one
  place; a version taking a URL would be an open request forwarder. The bytes
  are checked against the pin *before* anything is written, and the face's OFL
  licence is written beside it first, so the face is never on disk without its
  terms. The CSP is untouched: the fetch is Rust's, not the WebView's.
- Faces embedded in a reader's documents are held to what embedding needs, in
  `font.rs`: TrueType outlines (PDFium's loader describes no other shape
  correctly), an `fsType` that permits a subset, and coverage. A face failing any
  of them is the wrong candidate, not an error — the chain walks on, and its end
  is the fetch offer above.
- `delete_last_pdf_annotation` counts the session's own additions per page, never
  the frontend's undo history, so it cannot delete a link, form field, or comment
  already in the file.
- Watermarks are appended page content objects, not annotations. The app owns
  only the tail it appended this session — after save + reopen they are input
  content, so never call them redaction or tamper-proofing. A watermarked
  document goes only to a *copy*: `save` refuses, `export_to` compares paths
  (symlinks resolved first); a third write path needs the same guard.
- PDFium cannot write outlines, so the merge wizard's bookmark modes pass
  PDFium's freshly saved bytes to `outline.rs` (lopdf writes `/Outlines`, then
  reopens). lopdf parses **only this app's own output**; PDFium stays the sole
  parser of opened files.
- Security changes must also pass `bun run tauri:build` plus a manual WebView
  console check for unexpected CSP violations.

## Releases

`package.json` is the version source of truth; a `vX.Y.Z` tag must match it
exactly or the release workflow rejects it.
