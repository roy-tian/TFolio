---
name: run-app
description: Launch, drive, and screenshot the TFolio desktop app (Tauri 2 + React + Rust PDF editor). Use whenever the user wants to run, start, launch, open a PDF in, or screenshot TFolio, or to confirm a change actually works in the real app UI (viewer, drop zone, page rendering, bookmarks, language) — even if they don't say the word "run". Works on headless Linux with no display or GPU.
---

# Running & screenshotting TFolio

TFolio is a **Tauri 2** desktop app: React/TS frontend, Rust backend, PDFs
rendered by a bundled PDFium in the Rust process. There is **no dev server to
curl and no browser build** — "running it" means launching the compiled desktop
binary and looking at its WebView window. This machine is **headless Linux** (no
`$DISPLAY`, no GPU), so every launch goes through a virtual display.

## Quick start

One command handles the common cases — launching, optionally opening a PDF, and
saving a screenshot of the WebView:

```bash
# Screenshot the empty drop-zone state
.claude/skills/run-app/scripts/screenshot.sh --out .temp/screenshot.png

# Open a PDF and screenshot page 1 (toolbar shows 1 / N)
.claude/skills/run-app/scripts/screenshot.sh \
  --pdf .temp/2026-109-4010.pdf --out .temp/screenshot.png

# UI language (default zh-CN)
.claude/skills/run-app/scripts/screenshot.sh --lang en --out .temp/en.png
```

Then **open the PNG with the Read tool and look at it** — a screenshot you never
inspected proves nothing, and a black or blank-white frame means a failure (see
Gotchas). The script prints the saved path on stderr.

The wrapper builds the e2e binary on first use (a few minutes), then reuses it.
Rebuild after changing `src/` or `src-tauri/` so the screenshot isn't stale:
`bun run test:e2e:build`.

## How it works (and why)

The script drives the app through the **embedded WebDriver bridge** that the
`e2e` Cargo build enables (`withGlobalTauri` + `tauri-plugin-wdio-webdriver`).
This matters because the normal release WebView exposes **no automation hook** —
it's the only way to script "open this file", and its screenshots come from the
WebView itself, so they're crisp and immune to X/GPU quirks. Under the hood the
wrapper:

1. Exports the software-render env (see Gotchas — without it the window is black)
   and `PDFIUM_LIB_PATH`.
2. Builds `src-tauri/target/debug/tfolio` (the bridged binary) if missing.
3. Runs `xvfb-run … bunx wdio run wdio.conf.ts --spec scripts/open-and-screenshot.e2e.ts`.

The spec (`scripts/open-and-screenshot.e2e.ts`) is env-driven and reusable:

| var | meaning | default |
|---|---|---|
| `TFOLIO_PDF` | absolute path to a PDF to open; unset ⇒ empty-state shot | (unset) |
| `TFOLIO_SHOT` | output PNG path | `artifacts/run/screenshot.png` |
| `TFOLIO_LANG` | `zh-CN` or `en` | `zh-CN` |

To drive more of the UI (bookmarks, page jumps, About/Language menus,
invalid-file handling), copy the selectors from `test/e2e/pdf-viewer.e2e.ts` into
a spec and point `--spec` at it — same harness.

## Alternative: genuine release window (no PDF)

When you specifically need the **real release build's** OS window — e.g. to
confirm the production CSP doesn't break rendering — screenshot it directly. This
**cannot open a PDF** (no automation bridge; the file picker is a native GTK
dialog needing `xdotool`, which isn't installed):

```bash
bun run tauri:build                                # src-tauri/target/release/tfolio
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &     # run_in_background
export DISPLAY=:99
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
       LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe
export PDFIUM_LIB_PATH="$PWD/src-tauri/resources/pdfium/libpdfium.so"
./src-tauri/target/release/tfolio &                # run_in_background
# Window is 1100x760 centered on 1280x800 => region +90,+20; multi-frame grab
# gives the WebView time to paint, last frame wins.
ffmpeg -y -f x11grab -video_size 1100x760 -framerate 1 -i :99+90,20 \
  -frames:v 12 -update 1 .temp/screenshot.png
```

## Gotchas

Each of these was hit during first bring-up — they're the non-obvious failures.

- **Black WebView** → the software-render env is missing. Modern WebKitGTK uses a
  DMA-BUF renderer that fails with no GPU (`/dev/dri/card0: Permission denied`)
  and paints the whole window black. `WEBKIT_DISABLE_DMABUF_RENDERER=1` (plus the
  companions the script sets) forces software rendering. This is the #1 trap.
- **Blank white page in a PDF screenshot** = captured before the bitmap painted.
  The spec waits for the page `<canvas>` `width > 200` (PDFium done) *and* pauses
  ~3.5 s so it paints. Keep both if you write your own spec.
- **`length limit exceeded` when injecting a PDF** — the WebDriver bridge caps
  request-body size. The spec streams the file as **256 KB base64 chunks** and
  reassembles it in-page; don't send one blob.
- **Release build can't be scripted to open a file** — no `withGlobalTauri`, no
  bridge. Use the e2e build (the wrapper) for anything programmatic.
- **Stale UI** — the e2e binary embeds the frontend at build time. Re-run
  `bun run test:e2e:build` after editing `src/` or `src-tauri/`.
- **Don't `pkill -f 'target/release/tfolio'`** — the pattern also matches the
  shell running the command and kills it (exit 144). Use the bracket trick,
  `kill $(pgrep -f '[t]arget/release/tfolio')`, or kill the exact PID. Same for
  `[X]vfb`.
- **PDFium not found** → set `PDFIUM_LIB_PATH`, or run `bun run pdfium:download`.
  Debug build looks in `src-tauri/target/debug/pdfium/`, release in
  `src-tauri/resources/pdfium/`.
