# Icon assets

The five approved masters live in `src/assets/brand/`. Regenerate these desktop
assets with `bun run icons:generate`; Bun and the pinned Tauri CLI are sufficient.
The command also refreshes the website icons when `website/assets/` exists.

| Display size | Application | PDF document |
| --- | --- | --- |
| 16–20 px | app-small | file-tiny |
| 24–64 px | app-small | file-small |
| 128 px and above | app-large | file-large |

ICO files contain multiple sizes. ICNS files select artwork by logical size,
including Retina frames. The app uses the same masters for its favicon, About,
open-file area, recent files, and document tabs. The menu keeps its hamburger icon.

Windows NSIS and MSI installers register `pdf.ico` for TFolio's PDF file class.
macOS uses `pdf.icns` through `Info.plist`. Linux application icons are bundled;
PDF file-manager icons remain controlled by the desktop's MIME icon theme.
