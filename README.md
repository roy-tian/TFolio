# TFolio

[English](README.md) · [简体中文](README_zh.md)

TFolio is a desktop workspace for PDF (A folio is a leaf of a book): read your PDFs, mark them up, rearrange their pages, stamp watermarks and page numbers, and merge several files into one. Everything happens on your own machine — TFolio never uploads a document.

## Install

Download the installer for your platform from the [Releases page](https://github.com/roy-tian/TFolio/releases) — macOS (Apple Silicon and Intel), Windows x64, and Linux x64.

## Features

**Reading**

- Open PDFs by drag-and-drop, the file picker, or the recent-files list, with several documents open at once in tabs.
- Make TFolio your PDF handler and a double-clicked file opens straight in it — in the window you already have open, as another tab.
- Single page, book (two-page spread), and thumbnail views; zoom, fit to width or page, and rotate.
- Page indicator with jump-to-page, plus a bookmark sidebar built from the document's own table of contents.
- Select and copy text straight from the page.
- Print through your system's own print dialog, every page as it stands — marks, watermark, and the way you have it turned.

**Pages**

- Reorder pages by dragging them in the thumbnail grid.
- Cut or copy the selected pages — right-click, or Ctrl+X / Ctrl+C — and
  paste them into any gap: its button, or Ctrl+V in front of the page you
  have chosen.
- Copy pages into another open document: drag them onto its tab, hold until it
  opens, and drop them into its grid.
- Delete pages, insert blank ones, or start a new blank PDF.
- Drop another PDF onto the document to add its pages.

**Markup**

- Highlight text, draw rectangles with a translucent, mosaic, or blur effect, and add text notes in the colour and size you choose.
- Erase any single mark, wherever it sits in the editing history.
- Undo and redo throughout, then save in place or export a copy.

**Whole-document tools**

- A text watermark across every page — once or tiled, either diagonal, at the size you set.
- Page numbers along the bottom: fixed position or mirrored for double-sided binding, over the page range you pick, starting at any number, with a colour that turns white over dark areas and your choice of how blank pages count.
- A merge wizard that combines several PDFs in the order you set, carries over or rebuilds their bookmarks, optionally pads so each file starts on an odd page, and can add page numbers and a watermark to the result. Images (JPEG, PNG, WebP, BMP, GIF, TIFF) come in as pages of their own.
- One page size for the whole merge: every page fitted to A4, keeping its own size in the middle of the sheet where it already fits and scaling down where it does not, on a sheet turned to whichever way holds it better.
- Three ways out of the wizard: one merged PDF, one PNG per page as a ZIP, or a ZIP of watermarked copies with nothing merged at all.

**The app itself**

- Keyboard shortcuts for the everyday actions — new Ctrl+N, open Ctrl+O, save Ctrl+S, save as Ctrl+Shift+S, save all Ctrl+Alt+S, print Ctrl+P, search Ctrl+F, undo Ctrl+Z, watermark Ctrl+Alt+W, page numbers Ctrl+Alt+P (⌘ in place of Ctrl on macOS). The menu and the tooltips name them, and they answer only while a TFolio window has the keyboard.
- Save all writes back every open document that has changes of its own to save.
- English and Simplified Chinese, following your saved preference and otherwise the system language.
- Light and dark themes, following the system by default.
- Settings and the recent-files list are remembered between runs.
- Checks for a new release at startup, quietly. If one exists, a notice in the corner names the version and offers to download it, with progress, and then to install it and restart; if none does, it says nothing at all.

## Good to know

- PDFs up to 512 MiB can be opened.
- Pages are parsed and drawn by a PDF engine bundled inside the app, so a document's content is never handed to a web view or a server. TFolio reaches the network twice at most, and never with your document: once at startup, to ask GitHub whether a newer release exists, and once if you accept its offer to download a CJK font for a note or watermark that your system's own fonts cannot draw.
- Watermarks, mosaic, and blur are visual only. The text underneath is still there and still searchable — they are not redaction, and a determined PDF editor can undo them.
- Once you add a watermark, page numbers, or another file's pages, that document can only be exported as a copy; the file you opened is left untouched.
- An update is installed only from a package signed with TFolio's own release key, which the app carries and checks before it runs anything. Installing restarts the app, so it asks first.

## License

TFolio is available under the [MIT License](LICENSE).

Copyright © 2026 Roy Tian.
