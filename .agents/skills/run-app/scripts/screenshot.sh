#!/usr/bin/env bash
# Launch TFolio headlessly and screenshot its WebView — empty drop-zone state, or
# with a PDF opened to page 1. Wraps the whole verified sequence (software-render
# env, e2e-binary build check, Xvfb, wdio bridge) so callers run one command.
#
# Usage:
#   scripts/screenshot.sh [--pdf FILE] [--out PNG] [--lang zh-CN|en]
#
#   --pdf FILE   open this PDF and capture page 1 (default: empty drop-zone state)
#   --out PNG    output path (default: artifacts/run/screenshot.png)
#   --lang L     UI language, zh-CN (default) or en
#
# Requires (one-time): sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev \
#   librsvg2-dev xvfb ; and bun deps installed. See SKILL.md for the why behind
# each step and for the release-binary/ffmpeg alternative.
set -euo pipefail

PDF=""
OUT="artifacts/run/screenshot.png"
LANG_UI="zh-CN"
while [ $# -gt 0 ]; do
  case "$1" in
    --pdf)  PDF="$2"; shift 2 ;;
    --out)  OUT="$2"; shift 2 ;;
    --lang) LANG_UI="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .agents/skills/run-app/scripts -> repo root is four levels up.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"

# WebKitGTK uses a DMA-BUF renderer that fails with no GPU and paints the whole
# window black; these fallbacks force software rendering so the WebView is visible.
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export PDFIUM_LIB_PATH="$REPO_ROOT/src-tauri/target/debug/pdfium/libpdfium.so"

# The e2e Cargo build embeds the WebDriver bridge we drive below; a normal release
# build has no automation hook. Build it once if it isn't there.
if [ ! -x src-tauri/target/debug/tfolio ]; then
  echo "run-app: e2e binary missing, building (bun run test:e2e:build)…" >&2
  bun run test:e2e:build
fi

if [ -n "$PDF" ]; then
  [ -f "$PDF" ] || { echo "run-app: PDF not found: $PDF" >&2; exit 1; }
  export TFOLIO_PDF="$(readlink -f "$PDF")"
fi
export TFOLIO_SHOT="$OUT"
export TFOLIO_LANG="$LANG_UI"

echo "run-app: launching (pdf=${PDF:-<none>}, lang=$LANG_UI) → $OUT" >&2
xvfb-run -a --server-args="-screen 0 1280x800x24" \
  bunx wdio run wdio.conf.ts \
  --spec "$SCRIPT_DIR/open-and-screenshot.e2e.ts"
echo "run-app: saved screenshot to $OUT" >&2
