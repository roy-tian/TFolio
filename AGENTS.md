# Repository Constraints

## Workflow

- Tool output belongs under `artifacts/<tool>/`; `.temp/` holds hand-placed fixtures.
- Skills live in `.agents/skills/`; `.claude/skills/` contains symlinks only.
- TypeScript has no formatter: two-space indent, double quotes, no semicolons.
- Add UI primitives through shadcn's pinned `base-nova` registry.
- User-facing strings need keys in every locale; `en` defines the typed schema.
- Comments are WHY-only: delete any comment the code already makes obvious; keep
  only special, counterintuitive reasons, at most two lines per comment.
- One file, one concern. When a second domain settles into a file — another
  feature in one `impl` or component, fixtures beside tests — extract it to a
  submodule, hook or sibling module; ~1000 lines is the signal to look, and a
  cohesive domain may legitimately exceed it.
- Before a PR, run `bun run version:check`, `bun run test`, `bun run build`, and
  Cargo `fmt -- --check`, `clippy --locked -- -D warnings`, `check --locked`,
  `test --locked` against `src-tauri/Cargo.toml`. Backend or GUI changes also require `bun run test:all`.
- Fonts are not bundled. PDFium-dependent ignored Rust tests require `fonts:download`;
  missing fonts fail those tests rather than skipping them.
- e2e cannot drive native dialogs; use `window.__tfolioE2E` in e2e mode and
  `seedSettings` for settings that must survive refresh.
- `pdfium-render` is pinned behind a Cargo patch; read its manifest note before updating.
  CI's Bun version comes from `packageManager`, not the locally installed toolchain.
- Release tags must match `package.json`; use `version:bump` to keep all four version files aligned.
  A release's notes are `changelog` grouping the tag's conventional commit subjects,
  so those subjects are public text; `chore(release)` commits are left out.

## Persistence and windows

- Persist through `store.rs` as TOML in app data, never `localStorage`.
  Settings remain user-editable, so feature-specific guards must validate loaded values.
- PDFium, settings, recent files and approved paths are process-wide; document ownership is per window.
- Every command returning a new document must use `record_document`, including in-memory documents:
  an open can finish after its window was destroyed and must then release the document.
- Close documents on both window destruction and page reload; frontend cleanup cannot be relied on.
- Check `focus_pdf_path` before opening a file to avoid independent edit histories overwriting it.
  The caller's own tabs are checked locally because its ownership entry may be awaiting close.
- Never reuse window labels: delayed events must not target a replacement window.
  New windows inherit `tauri.conf.json`; production capabilities must cover `window-*`.
- File-manager launches steal OS focus; retain the last focused app window for launch routing.
  Queue and announce launches per window so another workspace cannot consume them.
- Settings writes replace the whole document. Keep other windows' snapshots current through
  `settings://changed`; theme and language still apply only at boot.
- GUI tests drive only `main`. Check multi-window changes manually with a separate file in each window.

## Security and PDF invariants

- PDFium alone parses opened PDFs. lopdf may parse only PDFium's freshly saved output for outlines,
  because PDFium cannot write outlines.
- Render in Rust; transfer bytes/images as raw IPC binary and decode with `createImageBitmap`, never `blob:`.
- Keep production CSP restrictive; relaxations belong only in `devCsp`.
  The Base UI settings select has a known `style-src-elem` violation; new sources are regressions.
- Capabilities do not gate custom commands in `generate_handler!`; validate arguments in Rust.
  Do not register the transitive `tauri-plugin-fs` plugin.
- Path-based open, insert, inspect and merge require `ensure_approved` (waived only in e2e).
  Approval must originate from Rust-observed OS paths, dialogs or the separate recent-files store.
- Never let editable settings approve file paths: an approved open also binds a later save destination.
- `export_pdf` reduces suggested names with `Path::file_name()`; `save_pdf` uses the recorded source only.
- Linux's desktop entry needs `%F`; Tauri's template omits it. Single-instance arguments must be absolute
  because relative paths would resolve against the running process's directory.
- Launch handling requires manual verification: build, then launch the binary with a PDF path twice.
  The GUI harness controls process startup and cannot cover this path.
- Validate insertion bounds in the engine, including e2e builds; refuse out-of-range positions.
- Cancellation commands must not use `spawn_blocking`: that pool can be waiting on the PDFium lock
  held by the operation being cancelled. Use only the small operations lock.
- Long loops under the shared PDFium lock need cancellation checks between pages/files and an explicit
  completion result. Rebuilds must roll back snapshots on cancellation; merges publish only on completion.
- Font downloads accept no caller-controlled URL or destination. Pin host, commit, size and SHA-256;
  verify bytes before writing and write the compiled-in OFL license before the font.
- The update check is Rust-side and process-wide: one per run, none in e2e builds, and no command takes
  a URL. Endpoint and verifying key live in `tauri.conf.json`; leave the updater plugin's own commands
  out of the capability file so the WebView can name neither.
- `createUpdaterArtifacts` signs every bundle, so anything that bundles needs `TAURI_SIGNING_PRIVATE_KEY`
  and its password: the two workflows as repository secrets, and `tauri:bundle` from the environment —
  it fails without them. Regenerating the key strands every installed copy on its current version.
- Installing an update restarts the process, discarding unsaved work in every window, not just the asking
  one. Confirm before installing, and refuse outright in a debug build: nothing in `target/` carries a
  bundle type, so the plugin falls back to replacing the running binary itself.
- The downloaded installer lives in the cache directory, never beside `settings.toml`, with the release's
  signature saved next to it so it outlives the run. The plugin's own check is private, so those bytes are
  used only after that signature verifies against the compiled-in key — before the notice offers them, and
  again before the install, because `.deb` and `.rpm` hand the file to a root installer.
- Match a saved installer by comparing its signature against the one this run's own fetch of the feed
  names, never by a version read off disk: that would let a genuinely signed older release be passed off
  as the new one.
- Embedded fonts need TrueType outlines, subset permission and glyph coverage. Resolve variable fonts
  to Regular before subsetting because PDFium does not select axis positions; skip unsuitable faces.
- Annotation deletion and hit testing must target only this session's mark IDs, never existing annotations
  or positions inferred from undo history.
- Watermarks are session-owned appended content, not redaction. After reopening they are input content.
  Watermarked documents must save only to copies, with symlink-resolved source-path checks on every write path.
- Security changes also require `bun run tauri:build` and a manual WebView console check for new CSP violations.
