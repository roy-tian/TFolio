/**
 * The GUI suite's stand-ins for what WebDriver cannot drive.
 *
 * Tauri seals `__TAURI_INTERNALS__.invoke` (non-writable, non-configurable),
 * so a test cannot stub the IPC boundary from outside, and the WDIO service's
 * mocks wrap only the `withGlobalTauri` copy — not the bundled API this app
 * calls. The seam therefore has to be the app's own. It is live only in the
 * `e2e` build: everywhere else the mode check is a compile-time constant and
 * the branch — hook and all — is dropped from the bundle.
 */
import type { PdfDocumentInfo, PdfExportOutcome } from "@/lib/pdf"
import type { PdfProgress } from "@/lib/progress"

export type E2eOverrides = {
  /** Stands in for the native save dialog and export command. */
  exportPdf?: (args: {
    documentId: number
    filterLabel: string
    suggestedName: string
  }) => Promise<PdfExportOutcome | null>
  /** Stands in for the native open-file dialog: a path, or null for cancel. */
  pickPdfPath?: () => Promise<string | null>
  /** Stands in for `open_pdf_from_path`, so a spec can hand the backend bytes
      with no path at all — the state the save key's disabled case needs. */
  openPdfFromPath?: (path: string) => Promise<unknown>
  /** Stands in for the merge wizard's multi-select dialog: the paths chosen,
      or none for cancel. */
  pickPdfPaths?: () => Promise<string[]>
  /** Stands in for the OS print dialog, which no driver can answer: the real
      one blocks the window until a person closes it. */
  printWindow?: () => Promise<void>
  /** Stands in for `inspect_pdf_files`, so a spec can put a file the backend
      cannot read on the wizard's list without writing one. */
  inspectPdfFiles?: (paths: string[]) => Promise<
    {
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
  /** Stands in for both archive exports, which put up a native save dialog no
      driver can answer. The path written, or null for a dismissed dialog. */
  exportPdfArchive?: (
    command: string,
    args: Record<string, unknown>,
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<string | null>
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
