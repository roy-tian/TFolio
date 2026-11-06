# Repository Constraints

## Workflow

- Put tool output under `artifacts/<tool>/`, temporary manual samples in `.temp/`, and persistent
  test fixtures beside their tests.
- Keep skills in `.agents/skills/`; `.claude/skills/` contains symlinks only.
- TypeScript has no formatter: use two-space indent, double quotes, and no semicolons.
- Add UI primitives through shadcn's pinned `base-nova` registry.
- Add user-facing string keys in every locale; `en` defines the typed schema.
- Comments explain only the non-obvious WHY, concisely.
- Keep files cohesive, extracting unrelated responsibilities; past about 1,000 lines, review
  whether a split improves clarity.
- Commits are conventional (husky runs commitlint) with `- ` bullet bodies.
- `src-tauri/engine` (`tfolio-engine`: PDFium, fonts, Word conversion) must not depend on Tauri.
  The app resolves paths into `EnginePaths` and owns commands, dialogs, windows, path approval,
  IPC image encoding, the async runtime, and e2e choices; the engine has no `e2e` feature.
- Page reordering calls the raw `FPDF_MovePages` binding in `page_reorder.rs`, bypassing
  `pdfium-render`'s page index cache: never keep a `PdfPage` alive past one engine call.
- CI takes Bun's version from `packageManager`, not the local toolchain.

## Validation

- Before a PR, run `bun run version:check`, `bun run build`, and Cargo `fmt --all -- --check`
  (without `--all` it skips the engine crate) and `clippy --locked -- -D warnings` (which subsumes
  `check`) against `src-tauri/Cargo.toml`. Then run `bun run test:all` for backend or GUI changes,
  else `bun run test` and Cargo `test --locked`.
- PDFium-dependent Rust tests are `#[ignore]`d and need `pdfium:download` and `fonts:download`
  (`test:all` runs both); missing fonts fail them rather than skip.
- `test:e2e:headless` reruns the GUI suite on the last `test:e2e:build`. Never run Cargo during
  it: debug builds overwrite the `target/debug/tfolio` each spec relaunches.
- e2e cannot drive native dialogs; use `window.__tfolioE2E` in e2e mode and `seedSettings` for
  settings that must survive refresh.
- WebDriver input is not real input: scripted keys ignore `preventDefault`, typing appends over a
  selection, clicks make no `dblclick` or hover. `test/e2e/nativePointer.ts` drives real pointers.
- GUI tests drive only `main`; check multi-window changes manually, a different file per window.
- Verify launch handling manually: build, then launch the binary with a PDF path twice; the GUI
  harness cannot cover process startup.
- Security changes also require `bun run tauri:build` and a check for new CSP violations; the e2e
  build runs the production CSP, so a `securitypolicyviolation` listener in a spec can do it.

## Release

- Release from the default branch: merge the working branch with `--no-ff` as
  `chore(release): merge develop for <version>`, then `bun run release <version>` aligns the four
  version files and commits `chore(release): <version>`. It runs no checks: push only after
  `bun run preflight` passes, then dispatch the `Release` workflow.
- Never push release tags: Release builds every platform once into a draft and publishes,
  creating the tag, only after every build and that commit's CI pass.
- `changelog` turns the release's conventional commit subjects into public release notes,
  omitting `chore(release)` commits.
- `preflight` uses `tauri:build` (`--no-bundle`) to keep signing keys out of local environments.
  Only Release and the optional, non-gating `Bundle dry-run` sign installers, with both
  `TAURI_SIGNING_*` repository secrets. Regenerating the key strands installed copies on their
  current version.
- The landing page lives only on the `gh-pages` branch and reads the latest release at load, so
  releases do not change it; its `assets/icon.svg` is a copy of `app-small.svg`.

## Persistence and windows

- Persist TOML through `store.rs` in app data, never `localStorage`; feature-specific guards must
  validate loaded, user-editable settings.
- PDFium, settings, recent files, and approved paths are process-wide; documents belong to windows.
- Every command returning a new document, including an in-memory one, must use `record_document`
  so an open finishing after window destruction releases the document.
- Close documents on window destruction and page reload; frontend cleanup is insufficient.
- Check `focus_pdf_path` before opening to prevent independent edit histories. Check the caller's
  tabs locally because their ownership entries may be awaiting close.
- Never reuse window labels; delayed events must not target replacement windows. New windows
  inherit `tauri.conf.json`; production capabilities must cover `window-*`.
- File-manager launches steal OS focus; route them to the last focused app window. Launch files
  and tabs moved in from another window wait in Rust, per window, until that page takes them:
  events reach only pages already listening.
- Linux's desktop entry needs `%F` (missing from Tauri's template). Single-instance arguments
  must be absolute; relative paths resolve against the running process's directory.
- Settings writes replace the whole document. Sync other windows through `settings://changed`;
  theme and language apply only at boot.

## Security and path approval

- Keep production CSP restrictive; relax only `devCsp`. The Base UI settings select has a
  known `style-src-elem` violation; new sources are regressions.
- Capabilities do not gate custom `generate_handler!` commands: validate arguments in Rust.
  Do not register the transitive `tauri-plugin-fs` plugin.
- Path-based open and organize sources require `ensure_approved` except in e2e.
  Approval must come from Rust-observed OS paths, dialogs, or the separate recent-files store.
- Editable settings must never approve paths: an approved open also binds a later save destination.
- `export_pdf` reduces suggested names with `Path::file_name()`; `save_pdf` uses only the
  recorded source.

## WebView UI

- Ship no `group-has-*`, `peer-has-*`, or `group-focus-within-*`, even from registry snippets or
  class names in comments: each makes WebView2 or WebKit restyle the whole document per DOM
  change or focus. `toolbar-tooltips.e2e.ts` guards.
- Corner messages go through `src/lib/notices.ts`; an error about a control still on screen stays
  beside it.
- Fetch what a copy writes when the selection is made: WebKit refuses a clipboard write that
  awaits IPC long after the keypress.
- Render in Rust; send images as raw IPC binary decoded by `createImageBitmap` in the decode
  worker (`imageDecode.ts`), never `blob:`. Page canvases are `bitmaprenderer` canvases: read
  pixels through a 2d copy, and release bitmaps with `transferFromImageBitmap(null)`, since
  resizing keeps them.

## PDF editing and cancellation

- Only PDFium parses opened PDFs. `lopdf` may parse freshly saved PDFium output for what PDFium
  cannot do: writing outlines, relinking bookmarks and split links, recompressing images, drawing
  signature widgets into their pages (`FPDFPage_Flatten` burns or drops every annotation).
- Validate insertion bounds in the engine, including e2e builds; reject out-of-range positions.
- Cancellation commands use only the small operations lock, never `spawn_blocking`, whose pool may
  wait on the PDFium lock held by the operation being cancelled.
- Long loops under the shared PDFium lock need cancellation checks between pages/files and an
  explicit completion result. Roll back rebuild snapshots on cancellation; publish assembled
  documents only on completion.
- Annotation deletion and hit testing target only this session's mark IDs, never existing
  annotations or positions inferred from undo history.
- Watermarks and page numbers are session-owned appended content, not redaction; after reopening
  they are input content. Save documents carrying them, or copies of pages that did, only to
  copies, checking symlink-resolved source paths on every write.
- Every PDFium write breaks every digital signature. A file a document or organize source opened
  with intact signatures (byte ranges checked on disk, off the lock, never the CMS) is never
  written over by any writer, even after Save As rebinds the document; an unchanged document's
  Save As copies the file's bytes instead. Changes and new files that break intact signatures wait
  for the reader's flatten-or-keep answer, which the engine records per document (per plan for an
  assembly) and enforces; a document flattens in place only before its first change, and a new file
  flattens its own copy.

## Organize workspace

- Organize sources are read-only and are not documents: no `record_document`, recent files, save
  binding, or `focus_pdf_path`. Each window's registry releases them on window destruction and on
  page reload up to the id cutoff taken at release, so a reloaded page keeps those added since.
- A source whose fingerprint (mtime and size) changed blocks assembly until removed or re-added.
- A viewer tab enters organize as its file on disk, never its document: ask about unsaved changes
  first. A fill the reader has not touched is not unsaved work and may be replaced without asking.
- Every assembled PDF goes through `record_document`; there is no unsaved preview. Save as PDF
  picks the destination in Rust's own dialog before assembling, writes and binds it like Save As,
  then opens it as that file's tab; a failed write closes it. Writes refuse only open documents'
  files and signed files, so a destination chosen over an unsigned source then blocks assembly.
- The plan's watermark and page numbers are stamped before the write and dropped from session
  ownership: the tab reads them as input content, as a reopen would, and may save over its file.

## Word and image import

- Images and Word files open as converted, sourceless in-memory PDFs. `openSources.ts` mirrors
  the engine's `MERGE_IMAGE_EXTENSIONS`.
- Convert only through installed suites (Word, WPS, LibreOffice; Windows stops at WPS), detected
  without starting one; e2e passes `WordSuites::Absent`.
- Suites read a staged copy, never the reader's file. Kill only processes this run spawned, never
  by name; a non-PDF output refuses that file.

## Fonts

- Font downloads accept no caller-controlled URL or destination. Pin host, commit, size, and
  SHA-256; verify bytes before writing and write the compiled-in OFL license before the font.
- Embedded fonts need TrueType outlines, subset permission, and glyph coverage. Resolve variable
  fonts to Regular before subsetting because PDFium ignores axis positions; skip unsuitable faces.

## Updates

- Check updates at startup and whenever About opens, in Rust and never in e2e; no command takes a
  URL. Keep the endpoint and verifying key in `tauri.conf.json`; exclude updater commands from
  WebView capabilities.
- Installing an update restarts the process and discards unsaved work in every window. Confirm if
  any window has unsaved work or cannot answer. Refuse in debug builds: without a bundle type under
  `target/`, the plugin falls back to replacing the running binary itself.
- Keep downloaded installers in the cache directory, away from `settings.toml`, with their release
  signatures beside them so they outlive the run. Verify against the compiled-in key before
  offering an installer and again before installing; `.deb` and `.rpm` installers run as root.
- Match a cached installer by its signature against this run's fetched feed, never by an on-disk
  version; an older release may also have a valid signature.
