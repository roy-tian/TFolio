import { invoke } from "@tauri-apps/api/core"

import type { NoticeChannel } from "@/hooks/useNotices"
import { workspaceOwner, type NoticeKind } from "@/lib/notices"
import { isWordPath } from "@/lib/openSources"
import {
  fileNameFromPath,
  type PdfOutlineItem,
  type PdfPageInfo,
  type PdfSignatures,
} from "@/lib/pdf"

/** The engine's refusal of a file that changed on disk after it was read
    (`SOURCE_CHANGED`): its pages may no longer be the ones the reader saw. */
const SOURCE_CHANGED = "tfolio:source-changed"

export function isSourceChanged(error: unknown) {
  return error === SOURCE_CHANGED || (error instanceof Error && error.message === SOURCE_CHANGED)
}

/** What the backend learns of a file read for its pages; `id` is absent where
    it could not be read, and `error` then says why where "unreadable" would not. */
export type FileSourceInfo = {
  error?: "converterMissing" | "conversionFailed"
  id?: number
  kind: "pdf" | "image" | "word"
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
  path: string
  signatures: PdfSignatures
}

/**
 * Reads files for their pages into the window's source list, which a
 * document's added files take their pages from. An office suite may take
 * minutes, so a conversion offers Stop in the corner; files that could not be
 * read are named there. Resolves to those read.
 */
export async function readFileSources(
  paths: string[],
  notices: NoticeChannel,
): Promise<FileSourceInfo[]> {
  const raise = (kind: NoticeKind, values: Record<string, string | number>) =>
    notices.raise({ kind, owner: workspaceOwner, values })
  const converting = paths.some(isWordPath)

  if (converting) {
    notices.raise({
      action: { kind: "fileAddStop" },
      kind: "fileAdding",
      owner: workspaceOwner,
    })
  }

  try {
    const infos = await invoke<FileSourceInfo[]>("read_pdf_sources", { paths })
    const refused = infos.filter((info) => info.id === undefined)

    if (refused.length > 0) {
      raise(
        refused.some((info) => info.error === "converterMissing")
          ? "filesConverterMissing"
          : "filesUnreadable",
        {
          count: refused.length,
          names: refused.map((info) => fileNameFromPath(info.path)).join(", "),
        },
      )
    }

    return infos.filter((info) => info.id !== undefined && info.pages.length > 0)
  } catch (error) {
    raise(
      String(error).includes("at most") ? "filesTooMany" : "filesUnreadable",
      { count: paths.length, names: paths.map(fileNameFromPath).join(", ") },
    )

    return []
  } finally {
    if (converting) {
      notices.retract(workspaceOwner, ["fileAdding"])
    }
  }
}
