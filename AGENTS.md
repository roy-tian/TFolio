# Repository Guidelines

TFolio is a PDF editor: Tauri 2 shell, React 19 + TypeScript frontend (Vite,
Tailwind v4, shadcn/ui, i18next), Rust backend rendering with a bundled PDFium.
`bun` runs everything.

## Layout

- `src/` — `components/ui/` (shadcn primitives), `hooks/`, `lib/` (framework-free
  logic, unit-tested), `i18n/locales/`.
- `src-tauri/src/` — `pdfium/` (engine, commands, geometry, font, watermark,
  page_numbers, outline, library), `store.rs`, `settings.rs`, `recent.rs`.
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

`bun update` and `cargo update` move everything inside the ranges already
declared, so a new major is always a hand edit to `package.json` or
`Cargo.toml`. Two things sit outside that: `pdfium-render`, pinned `=0.9.3`
behind a `[patch.crates-io]` rev (the note in `Cargo.toml` says why), and Bun
itself — `packageManager` is the only thing naming a version, since no workflow
passes `bun-version` to `setup-bun`, so bumping the local toolchain without that
field leaves CI quietly on the old Bun.

CI runs three jobs on every PR, and none of it is optional: frontend
(`version:check`, `test`, `build`), Rust (against `src-tauri/Cargo.toml` —
`cargo fmt -- --check`, `clippy --locked -- -D warnings`, `check --locked`,
`test --locked`), and, gated on both, a GUI job adding
`cargo test --locked -- --ignored` and the headless e2e suite. Run the first two
before a PR; add `test:all` for backend or GUI changes. Conventional Commits
enforced by commitlint on `commit-msg`.

## Style & tests

- Nothing lints or formats the TypeScript: two-space indent, double quotes, no
  semicolons — match the surrounding code. Import via `@/`. Rust: `cargo fmt`.
- New primitives: `bunx --bun shadcn@latest add <component>` (pinned
  `base-nova`); prefer registry variants over bespoke Tailwind.
- No hard-coded user-facing text — `useTranslation()`, key in every locale. `en`
  is the typed schema; gaps in `zh-CN` fail the build.
- Everything kept between runs goes through `store.rs`, in the app data
  directory, and all of it is TOML: the reader's settings in `settings.toml`,
  the recent list in `recent-files.toml`. Nothing persists in `localStorage` —
  `settings.rs` owns the file's shape (camelCase keys, so a setting has one name
  in the file, over IPC and in TypeScript; a section that will not parse resets
  alone), and `src/lib/settings.ts` loads it once in `main.tsx` before the first
  render, so every reader is a synchronous lookup on that snapshot. A new
  setting is a field in `settings.rs` plus a guarded read/store pair beside its
  feature — the guard belongs there because the file is the reader's to edit.
  e2e specs seed it with `seedSettings` (a real `set_settings`, so it survives
  the refresh) rather than through a stub.
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
    in the e2e build; `recent.rs` stores approved opens, re-approved at startup,
    in a file of its own rather than in `settings.toml` — hand-editing the
    settings must not become a way to name a file to open and save over.
  - `insert_pdf_from_path` validates its position in the engine, not the command,
    so the e2e build checks it too: an out-of-range index is refused, not clamped.
  - `cancel_pdf_operation` and `cancel_pdf_merge` are the two commands that must
    **not** run their work in `spawn_blocking`: every blocking thread is parked
    on the PDFium lock the run they have to reach is holding, so a cancel queued
    behind them would arrive with nothing left to cancel. They take the engine's
    small `operations` lock alone, and a document id — none at all, for a merge
    that has yet to make one — is all they need: the worst either can do is stop
    work the same page asked for.
  - `tauri-plugin-fs` is transitive and deliberately never registered.
- `download_pdf_note_font` is the app's only outbound request. It takes no
  argument the WebView could shape — host, pinned commit, size, SHA-256 and
  destination all live in `font.rs` — so it can fetch exactly one file to one
  place; a version taking a URL would be an open request forwarder. The bytes
  are checked against the pin *before* anything is written, and the face's OFL
  licence — compiled in, never fetched, so no second response can be written
  under that name — lands beside it first, so the face is never on disk without
  its terms. The CSP is untouched: the fetch is Rust's, not the WebView's.
- Faces embedded in a reader's documents are held to what embedding needs, in
  `font.rs`: TrueType outlines (PDFium's loader describes no other shape
  correctly), an `fsType` that permits a subset, coverage, and — since PDFium
  picks no axis position when it loads bytes, and a subset keeps outlines rather
  than axes — a variable face resolved to Regular before it is cut. A face
  failing any of them is the wrong candidate, not an error — the chain walks on,
  and its end is the fetch offer above.
- Only annotations this session added carry a mark id, and `delete_pdf_annotations`
  takes ids — never a page position and never the frontend's undo history — so it
  cannot reach a link, form field, or comment already in the file. The ids are
  what let the eraser take a mark out of the middle of a page's own stack while
  every other entry's undo still finds its own; `pdf_annotation_at_point` does the
  hit test, over that same session tail alone.
- A watermark or page-number rebuild walks every page under the documents lock,
  which is the app's one PDFium lock: while it runs, nothing else — an open of
  the next file included — can move. So it is interruptible. The flag is read
  between pages, never inside one, and the byte snapshot the transaction already
  keeps rolls a stopped run back exactly as it rolls a failed one back; the
  reader's stop reaches it through `cancel_pdf_operation`, and closing the
  document sends the same stop. A merge is stoppable the same way, between
  files, and needs no rollback at all — it builds off to the side and reaches
  the store only on its last step, so a stopped one hands back `None` and leaves
  nothing to close. A new long loop under that lock needs the same check, and a
  command that reports one needs its "did it land" answer.
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
