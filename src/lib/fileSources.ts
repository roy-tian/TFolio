import { invoke } from "@tauri-apps/api/core"

import type { NoticeChannel } from "@/hooks/useNotices"
import type { AskSignatures } from "@/hooks/useSignaturePrompt"
import { storedFilePreferences } from "@/lib/filePreferences"
import { workspaceOwner, type NoticeKind } from "@/lib/notices"
import { isWordPath } from "@/lib/openSources"
import {
  fileNameFromPath,
  type FileOptions,
  type PdfDocumentInfo,
  type PdfOutlineItem,
  type PdfPageInfo,
  type PdfSignatures,
  type SignatureDecision,
} from "@/lib/pdf"
import { storedSignatureHandling } from "@/lib/signatureHandling"

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

/** Lets go of sources no document took: a signed one would keep its file
    from every writer. Those an add or a merge took are already gone. */
export function releaseFileSources(read: FileSourceInfo[]) {
  const sourceIds = read.flatMap((info) => (info.id === undefined ? [] : [info.id]))

  if (sourceIds.length > 0) {
    void invoke("release_pdf_sources", { sourceIds }).catch(() => undefined)
  }
}

/** How files taken in now are laid out and saved: the reader's last choices. */
export function storedFileOptions(): FileOptions {
  const preferences = storedFilePreferences()

  return { perFileBookmarks: preferences.bookmarks, smartPadding: preferences.smartPadding }
}

/** The answers for the signed files among those read, by source id, and the
    one Settings gave every one of them when nobody was asked: nothing else
    on screen would show it was given. */
export type SourceSignatures = {
  asSet?: SignatureDecision
  signatures: Record<number, SignatureDecision>
}

/** Each signed file answered for itself, unless the reader gives the rest the
    same answer, or Settings gives every one of them. Null once the reader
    declines one: then none of the files goes in. */
export async function answerSourceSignatures(
  read: FileSourceInfo[],
  ask: AskSignatures,
): Promise<SourceSignatures | null> {
  const signed = read.filter((info) => info.id !== undefined && info.signatures.intact)
  const signatures: Record<number, SignatureDecision> = {}
  const fromSettings = new Set<SignatureDecision>()
  let asked = false
  let forRest: SignatureDecision | null = null

  for (const [index, info] of signed.entries()) {
    const remembered = storedSignatureHandling()

    if (forRest) {
      signatures[info.id!] = forRest
    } else if (remembered !== "ask") {
      signatures[info.id!] = remembered
      fromSettings.add(remembered)
    } else {
      asked = true
      const answer = await ask({
        context: "insert",
        count: 1,
        name: fileNameFromPath(info.path),
        rest: signed.length - index - 1,
      })

      if (!answer) {
        return null
      }

      signatures[info.id!] = answer.decision
      forRest = answer.forRest ? answer.decision : null
    }
  }

  return {
    asSet: !asked && fromSettings.size === 1 ? [...fromSettings][0] : undefined,
    signatures,
  }
}

/** How dropped files combine: into a new document of their own, as the one
    file read that is left to open alone, or not at all. */
export type MergedFiles =
  | { asSet?: SignatureDecision; document: PdfDocumentInfo; kind: "merged" }
  | { kind: "single"; path: string }
  | null

/**
 * Reads files and makes them a new document, each a file of its own as a
 * document's added files are, laid out and saved by the reader's last
 * choices. A single file read is handed back to be opened as itself: a
 * document of one added file would only be that file, unable to save.
 */
export async function mergeFiles(
  paths: string[],
  { ask, notices, ownTitle }: { ask: AskSignatures; notices: NoticeChannel; ownTitle: string },
): Promise<MergedFiles> {
  const read = await readFileSources(paths, notices)

  if (read.length < 2) {
    releaseFileSources(read)

    return read[0] ? { kind: "single", path: read[0].path } : null
  }

  const answers = await answerSourceSignatures(read, ask)

  if (!answers) {
    releaseFileSources(read)
    return null
  }

  try {
    const document = await invoke<PdfDocumentInfo>("merge_pdf_sources", {
      options: storedFileOptions(),
      ownTitle,
      signatures: answers.signatures,
      sourceIds: read.map((info) => info.id!),
    })

    return { asSet: answers.asSet, document, kind: "merged" }
  } catch (error) {
    // A refused merge keeps its sources, which nothing will take now.
    releaseFileSources(read)
    notices.raise({
      kind: isSourceChanged(error) ? "filesChanged" : "mergeFailed",
      owner: workspaceOwner,
    })

    return null
  }
}
