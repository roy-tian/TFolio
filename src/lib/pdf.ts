import type { PaddingSheet } from "@/lib/padding"

export type PdfOutlineItem = {
  items: PdfOutlineItem[]
  pageNumber: number | null
  title: string
}

export type PdfPageInfo = {
  height: number
  // Clockwise rotation in degrees (0/90/180/270). `width`/`height` are the
  // displayed dimensions with this rotation already applied.
  rotation: number
  /** The file the page belongs to, once a file was added to the document:
      an id among its `sections`. */
  section?: number
  /** Shows a signature field's widget; absent on nearly every page. */
  signed?: boolean
  width: number
}

/** How a document of several files is laid out and saved. */
export type FileOptions = {
  perFileBookmarks: boolean
  smartPadding: boolean
}

/** One file of a document others were added to, as the sidebar shows it: its
    bookmarks numbered for the pages as they now stand. */
export type PdfSection = {
  id: number
  outline: PdfOutlineItem[]
  title: string
}

/**
 * A run of text on a page and its bounding box, in PDF points with a top-left
 * origin. Used to overlay a selectable text layer on the rendered page image.
 */
export type PdfTextSpan = {
  height: number
  left: number
  text: string
  top: number
  width: number
}

export type PdfSearchRect = {
  height: number
  left: number
  top: number
  width: number
}

/** One occurrence in document order. A phrase wrapped across lines remains one
    result and carries one highlight rectangle for each line it touches. */
export type PdfSearchMatch = {
  pageNumber: number
  rects: PdfSearchRect[]
}

export type PdfSearchOutcome = {
  cancelled: boolean
  limitReached: boolean
  matches: PdfSearchMatch[]
}

/** What becomes of intact signatures once something would break them:
    flattened into the pages, keeping their look, or kept as fields that then
    read as invalid. */
export type SignatureDecision = "flatten" | "keep"

/** The digital signatures a file opened with. `intact` checks their structure
    in the file on disk, never who signed, and holds while the document is
    bound to that file, which is then never written over. */
export type PdfSignatures = {
  count: number
  /** The reader's answer, asked before the first change that breaks them. */
  decision: SignatureDecision | null
  /** Drawn into the pages in place, as a flatten does before the first edit. */
  flattened: boolean
  intact: boolean
}

export type PdfDocumentInfo = {
  /** As in a structure update; a document opens as its file alone. */
  hasForeignPages: boolean
  /** As in a structure update, which the session copies here: a new document
      of another one's pages can open already export-only. */
  hasMergedPages: boolean
  id: number
  numPages: number
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
  /** As in a structure update. */
  splitsByBookmarks: boolean
  /** The file this document was opened from; null when opened from bytes,
      which leaves nothing to save over. */
  path: string | null
  /** As in a structure update. */
  fileOptions?: FileOptions
  /** As in a structure update. */
  padding?: PaddingSheet[]
  /** As in a structure update. */
  sections?: PdfSection[]
  /** As the backend last reported them: an open, a structure update, or a
      Save As, which moves an edited document off the signed file. */
  signatures: PdfSignatures
}

/** What a file's badge says: signatures still intact in the file it is bound
    to, or signatures it carries that no longer hold — a rewrite's, or ones
    already broken when it opened. Flattened ones are page content, not signatures. */
export function signatureMark(signatures: PdfSignatures): "intact" | "broken" | null {
  if (signatures.intact) {
    return "intact"
  }

  return signatures.count > 0 && !signatures.flattened ? "broken" : null
}

export function isPdfSignatures(value: unknown): value is PdfSignatures {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const { count, decision, flattened, intact } = value as Record<string, unknown>

  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    (decision === null || decision === "flatten" || decision === "keep") &&
    typeof flattened === "boolean" &&
    typeof intact === "boolean"
  )
}

/** Whether the document is now bound to the file the export wrote: that, not
    the operation's name, is what decides the history counts as saved. */
export type PdfExportOutcome = {
  path: string
  savedToSource: boolean
  /** After the write: an unchanged copy leaves the document on the signed
      file, an edited one moves it off. */
  signatures: PdfSignatures
}

/** A written A4 copy, bound to its file. */
export type A4Saved = {
  document: PdfDocumentInfo
  /** The session's watermark or page numbers went along at the page's scale:
      they could not be lifted to be laid out again on the sheets. */
  layersScaled: boolean
}

/** The backend's refusal to write over a file another tab holds, kept in step
    with `EXPORT_TARGET_OPEN_ERROR` in `src-tauri/engine/src/pdfium/engine/io.rs`. */
export const EXPORT_TARGET_OPEN = "tfolio:export-target-open"

/** A copy-only document's export aimed at its own file, kept in step with
    `EXPORT_COPY_ONLY_ERROR` in `src-tauri/engine/src/pdfium/engine/io.rs`. */
export const EXPORT_COPY_ONLY = "tfolio:export-copy-only"

/** A destination the OS would not let the app write, kept in step with
    `EXPORT_DENIED_ERROR` in `src-tauri/engine/src/pdfium/engine/io.rs`. */
export const EXPORT_DENIED = "tfolio:export-denied"

/** A destination with no room left for the file, kept in step with
    `EXPORT_NO_SPACE_ERROR` in `src-tauri/engine/src/pdfium/engine/io.rs`. */
export const EXPORT_NO_SPACE = "tfolio:export-no-space"

/** A destination whose folder is gone since it was chosen, kept in step with
    `EXPORT_TARGET_MISSING_ERROR` in `src-tauri/engine/src/pdfium/engine/io.rs`. */
export const EXPORT_TARGET_MISSING = "tfolio:export-target-missing"

/** A copy whose document changed while it was built, kept in step with
    `EXPORT_DOCUMENT_CHANGED_ERROR` in `src-tauri/engine/src/pdfium/engine/io.rs`. */
export const EXPORT_DOCUMENT_CHANGED = "tfolio:export-document-changed"

/** A write over a file whose intact signatures it would break, kept in step
    with `EXPORT_SIGNED_ERROR` in `src-tauri/engine/src/pdfium/engine/signatures.rs`. */
export const EXPORT_SIGNED = "tfolio:export-signed"

/** An unchanged signed document's copy, refused because its file changed on
    disk since the open; kept in step with `SIGNED_ORIGINAL_CHANGED_ERROR`. */
export const SIGNED_ORIGINAL_CHANGED = "tfolio:signed-original-changed"

function isRefusal(error: unknown, code: string): boolean {
  return error === code || (error instanceof Error && error.message === code)
}

/** The notice a failed Save As becomes: the refusals the reader can act on
    are named, and anything else is the generic failure. */
export function exportFailureNotice(
  error: unknown,
):
  | "exportCopyOnly"
  | "exportDenied"
  | "exportDocumentChanged"
  | "exportFailed"
  | "exportNoSpace"
  | "exportSigned"
  | "exportSignedChanged"
  | "exportTargetMissing"
  | "exportTargetOpen" {
  if (isRefusal(error, EXPORT_TARGET_OPEN)) {
    return "exportTargetOpen"
  }

  if (isRefusal(error, EXPORT_NO_SPACE)) {
    return "exportNoSpace"
  }

  if (isRefusal(error, EXPORT_TARGET_MISSING)) {
    return "exportTargetMissing"
  }

  if (isRefusal(error, EXPORT_DOCUMENT_CHANGED)) {
    return "exportDocumentChanged"
  }

  if (isRefusal(error, EXPORT_COPY_ONLY)) {
    return "exportCopyOnly"
  }

  if (isRefusal(error, EXPORT_SIGNED)) {
    return "exportSigned"
  }

  if (isRefusal(error, SIGNED_ORIGINAL_CHANGED)) {
    return "exportSignedChanged"
  }

  return isRefusal(error, EXPORT_DENIED) ? "exportDenied" : "exportFailed"
}

/** Nothing here is patched into place: the page list and outline are
    replaced wholesale, the backend's document being the only truth. */
export type PdfStructureUpdate = {
  /** Pages an added file brought in remain: a save may not replace the
      document's file, only a Save As write the combined pages. */
  hasForeignPages: boolean
  /** Whether a page another file brought in is still in the document, which
      leaves it export-only; the backend answers, it being what `save_pdf` refuses. */
  hasMergedPages: boolean
  numPages: number
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
  /** Whether a split by bookmarks has a bookmark to cut at: the document's
      own, or once files were added, those a Save As would write. */
  splitsByBookmarks: boolean
  /** How those files are laid out and saved; absent with one file. */
  fileOptions?: FileOptions
  /** The blank pages a Save As will add between files, shown where it puts
      them; absent where there are none. */
  padding?: PaddingSheet[]
  /** The files the pages come from, once any were added, even with one left;
      absent for a document that never had any. */
  sections?: PdfSection[]
  signatures: PdfSignatures
}

/** Widest a single page may render on screen, in CSS pixels. */
export const MAX_PAGE_WIDTH = 896

// Mirrors MIN_RENDER_WIDTH, MAX_RENDER_WIDTH and MAX_THUMBNAIL_WIDTH in
// src-tauri/engine/src/pdfium/engine.rs; the backend rejects anything outside them.
export const MIN_RENDER_WIDTH = 64
export const MAX_RENDER_WIDTH = 4096
export const MAX_THUMBNAIL_RENDER_WIDTH = 512

// Floor for a page's render target, so a page squeezed into a narrow column
// still resolves well enough to read once the window widens again.
export const MIN_PAGE_RENDER_WIDTH = 240

/** Judged by the name alone: a path has no MIME type to consult, and the
    backend rejects anything PDFium cannot actually parse. */
export function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf")
}

/** Splits on both separators, so a Windows path reads as its file rather
    than the whole path. */
export function fileNameFromPath(path: string) {
  return path.split(/[/\\]/).pop() || path
}

/** A leading dot is part of the name, as in ".profile". */
export function fileStem(name: string) {
  const dot = name.lastIndexOf(".")

  return dot > 0 ? name.slice(0, dot) : name
}

export function dimensionsForRotation(
  rotation: number,
  width: number,
  height: number,
) {
  return rotation === 90 || rotation === 270
    ? { height: width, width: height }
    : { height, width }
}

/**
 * PDFium's ordinary anti-aliasing reads visibly soft at one backing pixel
 * per CSS pixel, so low-DPI surfaces supersample to this instead of 2x.
 */
export const MIN_PAGE_OUTPUT_SCALE = 1.25

/** Capped at 2, the renderer's upper bound; a zero or absent `dpr` falls
    back to 1, since a zero ratio never means "no pixels". */
export function resolveOutputScale(dpr: number, minOutputScale = 1) {
  return Math.min(Math.max(dpr || 1, minOutputScale), 2)
}

export type PageCandidate = {
  bottom: number
  pageNumber: number
  top: number
}

// Half is load-bearing: two stacked pages can never both clear it, so the
// rule collapses to "whichever shows most" — where Chrome and pdf.js land.
const MIN_CURRENT_PAGE_VISIBILITY = 0.5

/** Measured against the most the viewport could ever show, not the page's
    own height, so tall pages and short rows reach the same scale. */
function visibleFraction(
  candidate: PageCandidate,
  viewportTop: number,
  viewportBottom: number,
) {
  const height = candidate.bottom - candidate.top
  const viewportHeight = viewportBottom - viewportTop

  if (height <= 0 || viewportHeight <= 0) {
    return 0
  }

  const visible =
    Math.min(candidate.bottom, viewportBottom) -
    Math.max(candidate.top, viewportTop)

  return Math.max(0, visible) / Math.min(height, viewportHeight)
}

/** The page a jump went to (`CurrentPage.goTo`). `landedTop` is the view's
    scroll offset where it came to show the page, null until it has. */
export type JumpTarget = { landedTop: number | null; page: number; since: number }

// Several times what a smooth jump takes in WebKitGTK (about 0.3 s, however
// far): until then the jump is still arriving, and one that never showed its
// page by then was taken elsewhere by the reader.
export const JUMP_ARRIVAL_MS = 1500
// How far the view may move from where a jump landed, as a share of its
// height, before the reader counts as having read on from the page.
const JUMP_HOLD_SHARE = 0.25

/**
 * The page being read, given the jump that last went to a page. Near the end
 * of the document the view cannot bring a page to the top, and the usual rule
 * (`pickCurrentPage`) names an earlier one: the page gone to stays the page
 * being read while at least half of it shows and the view has moved less than
 * a quarter of its height from where the jump left it. While the jump is
 * arriving (or settling after a move the app made, `reland`) the page is
 * named whatever the layout shows meanwhile, rather than each page the scroll
 * passes or a relayout's passing frame, and the place it lands follows it:
 * zoomed out, the page can show long before the scroll stops.
 */
export function pickReadingPage(
  candidates: PageCandidate[],
  view: { bottom: number; scrollTop: number; top: number },
  jump: JumpTarget | null,
  now: number,
): { jump: JumpTarget | null; page: number | null } {
  const usual = () => ({ jump: null, page: pickCurrentPage(candidates, view.top, view.bottom) })

  if (jump === null) {
    return usual()
  }

  const target = candidates.find((candidate) => candidate.pageNumber === jump.page)
  const shows =
    target !== undefined &&
    visibleFraction(target, view.top, view.bottom) >= MIN_CURRENT_PAGE_VISIBILITY
  if (now - jump.since < JUMP_ARRIVAL_MS) {
    return { jump: shows ? { ...jump, landedTop: view.scrollTop } : jump, page: jump.page }
  }

  if (!shows) {
    return usual()
  }

  // First looked at only now, as when the tracker was paused meanwhile.
  if (jump.landedTop === null) {
    return { jump: { ...jump, landedTop: view.scrollTop }, page: jump.page }
  }

  const moved = Math.abs(view.scrollTop - jump.landedTop)

  return moved < (view.bottom - view.top) * JUMP_HOLD_SHARE ? { jump, page: jump.page } : usual()
}

/**
 * Not a fixed line down the viewport: a line deep enough to sit inside a
 * full page falls past a short row, handing the reader the row below.
 */
export function pickCurrentPage(
  candidates: PageCandidate[],
  viewportTop: number,
  viewportBottom: number,
): number | null {
  let currentPage: number | null = null
  // A gap between two tall pages can leave both just under the bar, so keep the
  // most visible page as a fallback rather than reporting nothing.
  let fallbackPage: number | null = null
  let fallbackFraction = -1

  for (const candidate of candidates) {
    const fraction = visibleFraction(candidate, viewportTop, viewportBottom)

    if (fraction >= MIN_CURRENT_PAGE_VISIBILITY) {
      if (currentPage === null || candidate.pageNumber < currentPage) {
        currentPage = candidate.pageNumber
      }
    } else if (
      fraction > fallbackFraction ||
      (fraction === fallbackFraction &&
        fallbackPage !== null &&
        candidate.pageNumber < fallbackPage)
    ) {
      fallbackFraction = fraction
      fallbackPage = candidate.pageNumber
    }
  }

  return currentPage ?? fallbackPage
}
