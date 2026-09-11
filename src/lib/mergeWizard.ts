import { invoke } from "@tauri-apps/api/core"

import { e2eOverride } from "@/lib/e2e"
import { fileNameFromPath, isPdfPath } from "@/lib/pdf"
import { wordConversionEnabled } from "@/lib/settings"

/** What a merge reads one of its sources as. Mirrors `MergeSourceKind` in
    `src-tauri/src/pdfium/mod.rs`. A Word document arrives as the PDF the
    machine's own office suite made of it. */
export type MergeSourceKind = "pdf" | "image" | "word"

/** Why a Word document could not become a PDF. Mirrors `MergeSourceError`
    in `src-tauri/src/pdfium/mod.rs`; the wizard words these itself. */
export type MergeSourceError = "converterMissing" | "conversionFailed"

/** The image formats a merge can bring in as pages, mirroring
    `MERGE_IMAGE_EXTENSIONS` in `engine.rs`. Both sides have to agree: this one
    decides what the wizard offers to inspect, that one what it can read. */
export const mergeImageExtensions = [
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "tif",
  "tiff",
  "webp",
] as const

export function isMergeImagePath(path: string) {
  const lowered = path.toLowerCase()

  return mergeImageExtensions.some((extension) =>
    lowered.endsWith(`.${extension}`),
  )
}

/** The Word formats a merge brings in as converted pages, mirroring
    `WORD_EXTENSIONS` in `src-tauri/src/convert/mod.rs`. */
export const mergeWordExtensions = ["doc", "docx"] as const

export function isMergeWordPath(path: string) {
  const lowered = path.toLowerCase()

  return mergeWordExtensions.some((extension) =>
    lowered.endsWith(`.${extension}`),
  )
}

/** Whether a merge can take this file at all — a PDF, an image it lays on a
    page of its own, or a Word document the machine's own office suite turns
    into one first. Word is behind its setting, because a reader who turned
    the conversions off has already answered what should happen here. */
export function isMergeSourcePath(path: string, word = true) {
  return (
    isPdfPath(path) || isMergeImagePath(path) || (word && isMergeWordPath(path))
  )
}

/**
 * What the wizard produces, which decides both the backend route it takes and
 * the questions worth asking on the way.
 *
 * `onePdf` is the merge proper. The two archives are written to a file the
 * reader picks rather than opened as a tab: neither a folder of images nor a
 * pile of separate documents is a thing this app can hold open.
 */
export type MergeExportMode = "onePdf" | "pagePngZip" | "watermarkOnlyZip"

export const mergeExportModes: readonly MergeExportMode[] = [
  "onePdf",
  "pagePngZip",
  "watermarkOnlyZip",
]

export function isMergeExportMode(value: unknown): value is MergeExportMode {
  return mergeExportModes.includes(value as MergeExportMode)
}

/** The steps a merge can ask about, named rather than numbered: which of them
    it actually asks depends on what it is producing. */
export type MergeWizardStep =
  | "files"
  | "bookmarks"
  | "pageNumbers"
  | "watermark"

/**
 * The steps `mode` asks, in order.
 *
 * A step is left out where its answer could not reach the result: an archive of
 * images carries no outline, and copies that were never merged have neither an
 * outline to build nor a page sequence to number — which is also the one
 * omission the wizard was asked for by name.
 */
export function mergeWizardSteps(
  mode: MergeExportMode,
): readonly MergeWizardStep[] {
  switch (mode) {
    case "pagePngZip":
      return ["files", "pageNumbers", "watermark"]
    case "watermarkOnlyZip":
      return ["files", "watermark"]
    default:
      return ["files", "bookmarks", "pageNumbers", "watermark"]
  }
}

/** Whether `mode` merges its sources into one page sequence — which is what
    makes the blank-page rule, and an outline, mean anything. */
export function mergesIntoOneDocument(mode: MergeExportMode) {
  return mode !== "watermarkOnlyZip"
}

/** How the merged document's outline is built from its sources'. Mirrored by
    `MergeBookmarks` in `src-tauri/src/pdfium/mod.rs`. */
export type MergeBookmarksMode =
  | "none"
  | "perFile"
  | "keepExisting"
  | "perFileWithExisting"

export const mergeBookmarksModes: readonly MergeBookmarksMode[] = [
  "none",
  "perFile",
  "keepExisting",
  "perFileWithExisting",
]

export function isMergeBookmarksMode(
  value: unknown,
): value is MergeBookmarksMode {
  return mergeBookmarksModes.includes(value as MergeBookmarksMode)
}

/** One file on the wizard's list, as the backend read it. `pageCount` is null
    for a file that could not be read — the row stays, marked unusable, rather
    than vanishing from a list the reader built. `error` says which of the two
    Word failures a Word row carries, because "unreadable" undersells both. */
export type MergeFile = {
  error: MergeSourceError | null
  hasOutline: boolean
  kind: MergeSourceKind
  name: string
  pageCount: number | null
  path: string
}

/** What the backend reports for one candidate file. */
type PdfFileSummary = {
  error?: MergeSourceError
  hasOutline: boolean
  kind: MergeSourceKind
  pageCount: number | null
  path: string
}

/** The most files one merge takes, mirroring `MAX_MERGE_FILES` in
    `engine.rs`; both sides refuse rather than trim, because the command stays
    callable outside this UI. */
export const MAX_MERGE_FILES = 64

/** A file the merge can actually use — one the backend read pages from. */
export function isUsableFile(
  file: MergeFile,
): file is MergeFile & { pageCount: number } {
  return file.pageCount !== null && file.pageCount > 0
}

export function usableFiles(files: MergeFile[]) {
  return files.filter(isUsableFile)
}

/**
 * Where each usable file's pages land, and how long the merged document ends
 * up. Mirrors `merge_files` in `engine.rs`: with `smartPadding` on, a blank
 * goes in before any file that would otherwise open on an even page, so every
 * file begins on a right-hand leaf when the result is printed double-sided.
 *
 * `startsAt` is 1-based and names the file's own first page, never the pad in
 * front of it — which is what a per-file bookmark points at.
 */
export function mergeLayout(files: MergeFile[], smartPadding: boolean) {
  let pages = 0
  const placements = usableFiles(files).map((file) => {
    const padded = smartPadding && pages % 2 === 1

    if (padded) {
      pages += 1
    }

    const startsAt = pages + 1
    pages += file.pageCount

    return { padded, path: file.path, startsAt }
  })

  return { placements, totalPages: pages }
}

export function mergedPageCount(files: MergeFile[], smartPadding: boolean) {
  return mergeLayout(files, smartPadding).totalPages
}

/** How many blank pages the smart-padding rule adds — what the first step
    reports so the switch's effect is visible before anything is merged. */
export function padPageCount(files: MergeFile[], smartPadding: boolean) {
  return mergeLayout(files, smartPadding).placements.filter(
    (placement) => placement.padded,
  ).length
}

/** Whether any file on the list brings bookmarks of its own — what makes the
    two keeping modes worth offering rather than quietly doing nothing. */
export function hasExistingBookmarks(files: MergeFile[]) {
  return usableFiles(files).some((file) => file.hasOutline)
}

/**
 * `files` with `incoming` added at the end, keeping the list's order and
 * dropping any path already on it: the same file twice is a gesture the reader
 * did not mean, and the wizard has no way to tell two copies apart.
 *
 * `dropped` counts what the ceiling turned away, so the wizard can say the list
 * is full rather than let files go missing without a word.
 */
export function appendFiles(files: MergeFile[], incoming: MergeFile[]) {
  const seen = new Set(files.map((file) => file.path))
  const combined = [
    ...files,
    ...incoming.filter((file) => {
      if (seen.has(file.path)) {
        return false
      }

      seen.add(file.path)
      return true
    }),
  ]

  return {
    files: combined.slice(0, MAX_MERGE_FILES),
    dropped: Math.max(0, combined.length - MAX_MERGE_FILES),
  }
}

/** `files` with the one at `from` moved to `to`, both 0-based. An index outside
    the list leaves the order alone, so a move past either end is simply not a
    move. */
export function moveFile(files: MergeFile[], from: number, to: number) {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= files.length ||
    to >= files.length
  ) {
    return files
  }

  const next = [...files]
  const [moved] = next.splice(from, 1)

  next.splice(to, 0, moved!)

  return next
}

/**
 * Whether the first step is answered: enough files the backend can actually
 * read.
 *
 * Two, because a merge of one file is not a merge — except for the mode that
 * merges nothing, where watermarking a single file is a whole answer and
 * demanding a second one would be a rule with no reason behind it.
 */
export function canMerge(files: MergeFile[], mode: MergeExportMode) {
  return usableFiles(files).length >= (mergesIntoOneDocument(mode) ? 2 : 1)
}

/** Reads each path's page count and whether it brings bookmarks. Paths of a
    kind no merge can take never reach the backend; the rest come back in the
    order given. */
export async function inspectFiles(paths: string[]): Promise<MergeFile[]> {
  const sourcePaths = paths.filter((path) =>
    isMergeSourcePath(path, wordConversionEnabled()),
  )

  if (sourcePaths.length === 0) {
    return []
  }

  const stub = e2eOverride("inspectPdfFiles")
  const summaries = stub
    ? await stub(sourcePaths)
    : await invoke<PdfFileSummary[]>("inspect_pdf_files", {
        paths: sourcePaths,
      })

  return summaries.map((summary) => ({
    error: summary.error ?? null,
    hasOutline: summary.hasOutline,
    kind: summary.kind,
    name: fileNameFromPath(summary.path),
    pageCount: summary.pageCount,
    path: summary.path,
  }))
}
