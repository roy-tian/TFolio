import { invoke } from "@tauri-apps/api/core"

import { e2eOverride } from "@/lib/e2e"
import { fileNameFromPath, isPdfPath } from "@/lib/pdf"
import { wordConversionAvailable } from "@/lib/wordConversion"

/** Mirrors `MergeSourceKind` in `src-tauri/src/pdfium/mod.rs`; a Word
    document arrives as the PDF the machine's office suite made of it. */
export type MergeSourceKind = "pdf" | "image" | "word"

/** Mirrors `MergeSourceError` in `src-tauri/src/pdfium/mod.rs`; the wizard
    words these itself. */
export type MergeSourceError = "converterMissing" | "conversionFailed"

/** Mirrors `MERGE_IMAGE_EXTENSIONS` in `engine.rs`; this one decides what the
    wizard offers to inspect, that one what it can read. */
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

/** Mirrors `WORD_EXTENSIONS` in `src-tauri/src/convert/mod.rs`. */
export const mergeWordExtensions = ["doc", "docx"] as const

export function isMergeWordPath(path: string) {
  const lowered = path.toLowerCase()

  return mergeWordExtensions.some((extension) =>
    lowered.endsWith(`.${extension}`),
  )
}

/** Word follows the machine's own answer: where no office suite was detected,
    the extension is not a source this run can accept. */
export function isMergeSourcePath(path: string, word = true) {
  return (
    isPdfPath(path) || isMergeImagePath(path) || (word && isMergeWordPath(path))
  )
}

export type MergeWizardStep =
  | "files"
  | "bookmarks"
  | "pageNumbers"
  | "watermark"

export function mergeWizardSteps(options: {
  bookmarksOn: boolean
  pageNumbersOn: boolean
  watermarkOn: boolean
}): readonly MergeWizardStep[] {
  const steps: MergeWizardStep[] = ["files"]

  if (options.bookmarksOn) steps.push("bookmarks")
  if (options.pageNumbersOn) steps.push("pageNumbers")
  if (options.watermarkOn) steps.push("watermark")

  return steps
}

// The backend also accepts "none", supplied only when bookmarks are disabled.
export type MergeBookmarksMode =
  | "perFile"
  | "keepExisting"
  | "perFileWithExisting"

export const mergeBookmarksModes: readonly MergeBookmarksMode[] = [
  "perFile",
  "keepExisting",
  "perFileWithExisting",
]

export function isMergeBookmarksMode(
  value: unknown,
): value is MergeBookmarksMode {
  return mergeBookmarksModes.includes(value as MergeBookmarksMode)
}

/** `pageCount` null means unreadable: the row stays, marked unusable, rather
    than vanishing from a list the reader built. */
export type MergeFile = {
  allPagesA4: boolean | null
  error: MergeSourceError | null
  hasOutline: boolean
  kind: MergeSourceKind
  name: string
  pageCount: number | null
  path: string
}

type PdfFileSummary = {
  allPagesA4: boolean | null
  error?: MergeSourceError
  hasOutline: boolean
  kind: MergeSourceKind
  pageCount: number | null
  path: string
}

/** Mirrors `MAX_MERGE_FILES` in `engine.rs`; both sides refuse rather than
    trim, the command staying callable outside this UI. */
export const MAX_MERGE_FILES = 64

export function isUsableFile(
  file: MergeFile,
): file is MergeFile & { pageCount: number } {
  return file.pageCount !== null && file.pageCount > 0
}

export function usableFiles(files: MergeFile[]) {
  return files.filter(isUsableFile)
}

/**
 * Mirrors `merge_files` in `engine.rs`: a blank goes in before a file that
 * would open on an even page, so printed double-sided every file starts right.
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
 * Drops paths already on the list — the wizard cannot tell two copies of one
 * file apart — and counts what the ceiling turned away so none go unmissed.
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

export function canMerge(files: MergeFile[]) {
  return usableFiles(files).length >= 2
}

export function a4Status(files: MergeFile[]): "empty" | "unknown" | "allA4" | "needsA4" {
  const usable = usableFiles(files)

  if (usable.length === 0) return "empty"
  if (usable.some((file) => file.allPagesA4 === false)) return "needsA4"
  if (usable.some((file) => file.allPagesA4 !== true)) return "unknown"

  return "allA4"
}

export async function inspectFiles(paths: string[]): Promise<MergeFile[]> {
  const sourcePaths = paths.filter((path) =>
    isMergeSourcePath(path, wordConversionAvailable()),
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
    allPagesA4: summary.allPagesA4,
    error: summary.error ?? null,
    hasOutline: summary.hasOutline,
    kind: summary.kind,
    name: fileNameFromPath(summary.path),
    pageCount: summary.pageCount,
    path: summary.path,
  }))
}
