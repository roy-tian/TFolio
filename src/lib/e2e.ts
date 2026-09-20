/**
 * Tauri seals `__TAURI_INTERNALS__.invoke`, so the e2e seam must be the app's
 * own; the mode check is a compile-time constant, dead in every other build.
 */
import type { PdfDocumentInfo, PdfExportOutcome } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"
import type { ArchiveExportRequest } from "@/lib/archiveExport"
import type { CompressedExportRequest } from "@/lib/compressExport"

export type E2eOverrides = {
  installUpdate?: () => Promise<void>
  exportPdfArchive?: (
    args: ArchiveExportRequest & { documentId: number },
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<string | null>
  exportCompressedPdf?: (
    args: CompressedExportRequest & { documentId: number },
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<string | null>
  exportPdf?: (args: {
    documentId: number
    filterLabel: string
    suggestedName: string
  }) => Promise<PdfExportOutcome | null>
  pickPdfPath?: () => Promise<string | null>
  /** Stands in for `open_pdf_from_path`, so a spec can hand the backend bytes
      with no path at all — the state the save key's disabled case needs. */
  openPdfFromPath?: (path: string) => Promise<unknown>
  /** Stands in for `open_converted_from_path`, so a spec can answer an image
      or Word open without a real conversion behind it. */
  openConvertedFromPath?: (path: string) => Promise<unknown>
  /** Stand in for the tab-move commands, so a spec can answer a tear-off or a
      cross-window drop without a second window on the single lane it drives. */
  moveDocument?: (args: {
    documentId: number
    destLabel: string
    tab: unknown
  }) => Promise<void>
  moveDocumentNewWindow?: (args: {
    at: { x: number; y: number } | null
    documentId: number
    tab: unknown
  }) => Promise<void>
  pickPdfPaths?: () => Promise<string[]>
  /** Stands in for the OS print dialog, which no driver can answer: the real
      one blocks the window until a person closes it. */
  printWindow?: () => Promise<void>
  /** Stands in for `inspect_pdf_files`, so a spec can put a file the backend
      cannot read on the wizard's list without writing one. */
  inspectPdfFiles?: (paths: string[]) => Promise<
    {
      allPagesA4: boolean | null
      error?: "converterMissing" | "conversionFailed"
      hasOutline: boolean
      kind: "pdf" | "image" | "word"
      pageCount: number | null
      path: string
    }[]
  >
  /** Stands in for `merge_pdf_files`, whose result a spec would otherwise have
      to build a real multi-file merge to reach. */
  mergePdfFiles?: (
    plan: {
      bookmarks: string
      normalizeA4: boolean
      paths: string[]
      smartPadding: boolean
    },
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<PdfDocumentInfo>
}

/** Compile-time constant; every `if (isE2eBuild)` body is dead code outside
    the `e2e` Vite mode. */
export const isE2eBuild = import.meta.env.MODE === "e2e"

export function e2eOverride<Name extends keyof E2eOverrides>(
  name: Name,
): E2eOverrides[Name] | undefined {
  if (!isE2eBuild) {
    return undefined
  }

  return (window as Window & { __tfolioE2E?: E2eOverrides }).__tfolioE2E?.[
    name
  ]
}
