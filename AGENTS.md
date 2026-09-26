# Repository Constraints

## Workflow

- Put tool output under `artifacts/<tool>/`, temporary manual samples in `.temp/`,
  and persistent test fixtures beside their tests.
- Keep skills in `.agents/skills/`; `.claude/skills/` contains symlinks only.
- TypeScript has no formatter: use two-space indent, double quotes, and no semicolons.
- Add UI primitives through shadcn's pinned `base-nova` registry.
- Add user-facing string keys in every locale; `en` defines the typed schema.
- Explain non-obvious WHY in comments; keep them concise and omit self-evident descriptions.
- Keep files cohesive; extract unrelated responsibilities. Around 1,000 lines, review whether
  splitting improves clarity; cohesive files may exceed it.
- Before updating the patched `pdfium-render`, read its Cargo manifest note.
- CI takes Bun's version from `packageManager`, not the local toolchain.

## Validation

- Before a PR, run `bun run version:check`, `bun run test`, `bun run build`, and Cargo
  `fmt -- --check`, `clippy --locked -- -D warnings` (which subsumes `check`), and `test --locked`
  against `src-tauri/Cargo.toml`. Backend or GUI changes also require `bun run test:all`.
- Run overlapping checks once; `test:all` satisfies the `bun run test` and Cargo `test --locked` requirements.
- PDFium test fonts are not bundled. PDFium-dependent ignored Rust tests require `fonts:download`;
  missing fonts fail those tests instead of skipping them.
- e2e cannot drive native dialogs; use `window.__tfolioE2E` in e2e mode and `seedSettings`
  for settings that must survive refresh.
- GUI tests drive only `main`; manually check multi-window changes with a separate file in each window.
- Verify launch handling manually: build, then launch the binary with a PDF path twice;
  the GUI harness cannot cover process startup.
- Security changes also require `bun run tauri:build` and a manual WebView console check for new CSP violations.

## Release

- Release tags must match `package.json`; use `version:bump` to align all five version files.
  `changelog` groups the release's conventional commit subjects as public release notes and omits
  `chore(release)` commits.
- Releases come only from the default branch; merge the working branch in with `--no-ff`.
- Push the release commit only after `bun run preflight` passes locally, then dispatch the
  `Release` workflow on it. Never push release tags: Release builds every platform once into a
  draft and publishes, creating the tag, only after every build and that commit's CI pass.
- `preflight` uses `tauri:build` (`--no-bundle`) so private signing keys stay out of local
  environments. Release and the optional, non-gating `Bundle dry-run` alone sign installers with
  both `TAURI_SIGNING_*` repository secrets. Regenerating the key strands installed copies on
  their current version.

## Persistence and windows

- Persist TOML through `store.rs` in app data, never `localStorage`; feature-specific guards
  must validate loaded, user-editable settings.
- PDFium, settings, recent files, and approved paths are process-wide; documents belong to windows.
- Every command returning a new document, including an in-memory one, must use `record_document`
  so an open finishing after window destruction releases the document.
- Close documents on window destruction and page reload; frontend cleanup is insufficient.
- Check `focus_pdf_path` before opening to prevent independent edit histories. Check the caller's
  tabs locally because their ownership entries may be awaiting close.
- Never reuse window labels; delayed events must not target replacement windows. New windows
  inherit `tauri.conf.json`; production capabilities must cover `window-*`.
- File-manager launches steal OS focus. Route them to the last focused app window, and queue
  and announce them per window so another workspace cannot consume them.
- Linux's desktop entry needs `%F` (missing from Tauri's template). Single-instance arguments
  must be absolute; relative paths resolve against the running process's directory.
- Settings writes replace the whole document. Sync other windows through `settings://changed`;
  theme and language apply only at boot.

## Security and path approval

- Keep production CSP restrictive; relax only `devCsp`. The Base UI settings select has a
  known `style-src-elem` violation; new sources are regressions.
- Capabilities do not gate custom `generate_handler!` commands: validate arguments in Rust.
  Do not register the transitive `tauri-plugin-fs` plugin.
- Path-based open, insert, inspect, and merge require `ensure_approved` except in e2e.
  Approval must come from Rust-observed OS paths, dialogs, or the separate recent-files store.
- Editable settings must never approve paths: an approved open also binds a later save destination.
- `export_pdf` reduces suggested names with `Path::file_name()`; `save_pdf` uses only the
  recorded source.

## PDF editing and cancellation

- Only PDFium parses opened PDFs. `lopdf` may parse freshly saved PDFium output for outlines,
  which PDFium cannot write.
- Render in Rust; transfer bytes/images as raw IPC binary and decode with `createImageBitmap`,
  never `blob:`.
- Validate insertion bounds in the engine, including e2e builds; reject out-of-range positions.
- Cancellation commands use only the small operations lock, never `spawn_blocking`, whose pool
  may wait on the PDFium lock held by the operation being cancelled.
- Long loops under the shared PDFium lock need cancellation checks between pages/files and an
  explicit completion result. Roll back rebuild snapshots on cancellation; publish merges only on completion.
- Annotation deletion and hit testing target only this session's mark IDs, never existing
  annotations or positions inferred from undo history.
- Watermarks are session-owned appended content, not redaction; after reopening they are input
  content. Save watermarked documents only to copies, checking symlink-resolved source paths on every write.

## Fonts

- Font downloads accept no caller-controlled URL or destination. Pin host, commit, size, and SHA-256;
  verify bytes before writing and write the compiled-in OFL license before the font.
- Embedded fonts need TrueType outlines, subset permission, and glyph coverage. Resolve variable
  fonts to Regular before subsetting because PDFium ignores axis positions; skip unsuitable faces.

## Updates

- Check updates once per process in Rust, never in e2e; no command takes a URL. Keep the
  endpoint and verifying key in `tauri.conf.json`; exclude updater commands from WebView capabilities.
- Installing an update restarts the process and discards unsaved work in every window. Confirm
  if any window has unsaved work or cannot answer. Refuse in debug builds: without a bundle type
  under `target/`, the plugin falls back to replacing the running binary itself.
- Keep downloaded installers in the cache directory, away from `settings.toml`, with the release
  signature beside them so it outlives the run.
  Verify against the compiled-in key before offering the installer and again before installing;
  `.deb` and `.rpm` installers run as root.
- Match a cached installer by its signature against this run's fetched feed, never by an on-disk
  version; an older release may also have a valid signature.
