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
- Specs under `test/e2e/extended/` lock frame timing and pointer feel (preview hand-offs, the
  overlay scrollbar, text hit testing, resize), which a loaded machine jitters: CI runs them, a
  local run only with `TFOLIO_E2E_EXTENDED=1`. Run them locally after touching what they lock.
- An e2e test proves what only the GUI can: wiring, dialogs, focus, layout. What the engine or a
  unit test already proves (pixels after undo, layers not stacking) gets one smoke test per
  feature, not a GUI copy.
- e2e cannot drive native dialogs; use `window.__tfolioE2E` in e2e mode and `seedSettings` for
  settings that must survive refresh.
- An event a spec emits reaches only listeners already bound, and the app binds its own some IPC
  turns after a reload paints: `emitDrag` waits on the e2e build's `html[data-file-drops]` mark.
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
- Check `find_open_file` before opening to prevent independent edit histories. It matches by file
  identity (`FileKey`), never spelling, and takes the caller's live tab ids because their
  ownership entries may be awaiting close. A file opened again after another writer changed it
  reloads its tab, asking first over unsaved work; saves record their own writes as not changes.
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
- Path-based opens and file sources require `ensure_approved` except in e2e.
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
- A menu entry that starts an edit in place unmounts its menu content on close (no fade) and
  answers `finalFocus` false: a Base UI menu still fading holds focus, and takes it back from
  the field, whose blur ends the edit.
- Navigation moves the page being read through `CurrentPage.goTo`, never `set` (the tracker's):
  the end of a document cannot bring a page to the top, so the page gone to stays the page being
  read while half of it shows and the view moves under a quarter of its height
  (`pickReadingPage`). An in-place edit that clamps the scroll, and a zoom's or resize's
  re-anchoring, call `reland`; an edit that renumbers the pages calls `renumbered`.
- The reading view has one right-click menu (`ViewerMenu`), for a page's text and for the page
  pressed: a Base UI context-menu trigger stops the event where it lands, so a trigger on each
  page's text would take every press from one around it.
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
  explicit completion result. Roll back rebuild snapshots on cancellation; publish built copies
  (an A4 copy) only on completion.
- Annotation deletion and hit testing target only this session's mark IDs, never existing
  annotations or positions inferred from undo history.
- Watermarks and page numbers are session-owned appended content, not redaction; after reopening
  they are input content. Save documents carrying them, or copies of pages that did, only to
  copies, checking symlink-resolved source paths on every write.
- Every PDFium write breaks every digital signature. A file a document opened, or a file added
  with intact signatures (byte ranges checked on disk, off the lock, never the CMS) is never
  written over by any writer, even after Save As rebinds the document; an unchanged document's
  Save As copies the file's bytes instead. Changes and new files that break intact signatures wait
  for the reader's flatten-or-keep answer, which the engine records per document (per signed file
  for added files) and enforces; a document flattens in place only before its first change, and a
  new file flattens its own copy.

## Save as A4

- `fit_to_a4` builds a copy of every page fitted onto A4 (with the blank pages and per-file
  bookmarks a Save As writes); a form XObject leaves annotations, links and fields behind. This
  session's watermark and page numbers are lifted from a copy first (only where `verify_owned_tail`
  holds, else they scale along and the reader is told) and stamped again on the sheets as the
  copy's own content (`stamp_layers`, which keeps no rollback snapshot of a copy it may discard).
  The stripped copy closes through `MergeDraft`, under the lock, however the run ends.
  `save_a4_pdf` asks for the destination in Rust first, records the copy with `record_document`,
  binds it like Save As, and the tab shows it in place of the document it was made from.

## Files added to a document

- A document takes other files as files of its own (engine `SectionBook`): they are read through
  the window's file sources (`read_pdf_sources`), then imported by `insert_pdf_files`, which
  releases them; sources never added go by `release_pdf_sources`. One history entry adds them all;
  its undo deletes the run under its stash.
- A file drop opens a tab per file, except on the sidebar, which takes the files into one document
  whichever panel shows: the shown tab's (where let go among its pages or its outline's files, else
  at the end), or on the home tab, for two or more, a new sourceless one (`merge_pdf_sources`: no
  page of its own, no history). Files no flow takes are named (`filesSkipped`), never dropped
  silently.
- Every insert names the file its pages join, and a reorder passes each position's file after
  and before: a page let go among another file's pages joins it, but a file moved whole by its
  name keeps its own. A deleted page keeps its file for the restore an undo brings back.
- A file let go among another's pages parts it into runs. The headings over the sidebar's
  pages, its tree of files (`fileRuns`) and the Save As outline (`SectionBook::outline`) all list
  a file once per run, its own bookmarks under the first; rename, remove, choose, fold and drag
  act on the file whole.
- Pages in hand show under the name of the file a release would leave them in (`flowItems`'
  `joins`): between two files, the preview is the result.
- Pages an added file brought, and copies of them, are foreign: `save` refuses while any remain,
  and Save As never writes the document's own file. Save As writes one bookmark per file (lopdf),
  then the tab reopens the written file, its history gone, which the corner says
  (`filesCombined`). A compressed copy compresses what a Save As writes (`combined_bytes`), and a
  split by bookmarks cuts at the outline it writes, which the engine reports as
  `splitsByBookmarks`.
- Blank pages between files are never pages of the document: the engine reports where a Save As
  will put them (`SectionBook::padding`) with every structure change, the viewer, sidebar and
  print show them there, and only a Save As writes them. Structure commands never see them. A
  drag shows them where its drop would leave them by the same rule (`paddingPositions`, kept in
  step with `SectionBook::padding`).
- The sidebar's pages are the one place pages are arranged: one column as it opens, rows of
  fixed-size cells once widened (`ui.sidebarWidth`). The bar over them, and the Delete and
  clipboard keys, act on the chosen pages, else the page being read, never on one folded away; a
  plain click's choice lapses once another page is the page being read, so nothing is acted on out
  of sight. Pages a paste or an add brings are chosen and shown where they landed (`showLanded`),
  the reader left where they are. The pages and the bookmarks (the tree of files, for several) are
  both there for every document: which shows is the window's layout, never a matter of what the
  document holds.
- The page clipboard is the window's, one store (`holdPages` in `lib/pageClipboard.ts`) of
  which each session reads its half and keeps no copy: the last pages cut or copied in any of
  its documents, as that document's page numbers, which it lets go at its next structure edit.
  Another document pastes them as copies, only while their own has no structure edit in flight
  or landed since (`pagesStanding`, asked again after any prompt, as the copy is made, as a drag
  from another tab and a new PDF of pages ask); a cut pasted there is deleted by the document it
  was made in, queued there as the copy starts and made once it lands, one undo in each. A cut of
  every page its document has stays there too, and the corner says so (`pagesCutKept`).
- A document with no file of its own has Save As for its save button and key, as one holding
  foreign pages has (`saveAsOnly`); the menu's Save stays disabled.
- A file folded to its name is one cell of the flow standing for its pages (`data-flip-bar`,
  `flowItems`): a drop lands above or below it, never inside. `flowLanding` counts cells, so
  every landing goes through `pagesBeforeSlot` before it names a page. Folding is a tab's own
  state, kept while the sidebar shows something else, never a stored preference, and lets go of
  the pages chosen in the file: none is deleted or cut unseen.
- Pages still showing as several files keep the document Save-As-only even with no foreign page
  left, so a save never drops the blanks and file bookmarks the reader sees.
- File sources are read-only and are not documents: no `record_document`, recent files, save
  binding, or `find_open_file`. Each window's registry releases them on window destruction and on
  page reload up to the id cutoff taken at release, so a reloaded page keeps those added since.
  A source whose fingerprint (mtime and size) changed since it was read is refused once it must be
  read again; the e2e build's `unload_pdf_sources` forces that re-read.

## Word and image import

- Images and Word files open as converted, sourceless in-memory PDFs, recorded as
  `DocumentFile::Converted` so opening the source again finds their tab until Save As binds a PDF.
  `openSources.ts` mirrors the engine's `MERGE_IMAGE_EXTENSIONS`.
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
