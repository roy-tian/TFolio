import { Channel, invoke } from "@tauri-apps/api/core"

import type { NoticeChannel } from "@/hooks/useNotices"
import type { AskSignatures } from "@/hooks/useSignaturePrompt"
import { mergeLimit, type AskBatchLimit } from "@/lib/batchLimits"
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

/** Which file of an add or a merge is under way: how many went before it, of
    how many, and its name. */
export type SourceProgress = { completed: number; name: string; total: number }

/** Past this many files an add or a merge shows its bar. */
const PROGRESS_FROM = 4

/** The engine's report of each file, put in the corner as the half of the bar
    `stage` stands for: reading, then putting the files in. Only long runs say
    so; a few files are done before a bar would mean anything. */
function filesProgress(
  notices: NoticeChannel,
  count: number,
  stage: "read" | "join",
): Channel<SourceProgress> {
  const channel = new Channel<SourceProgress>()

  if (count >= PROGRESS_FROM) {
    channel.onmessage = (progress) => raiseFilesProgress(notices, stage, progress)
  }

  return channel
}

function raiseFilesProgress(
  notices: NoticeChannel,
  stage: "read" | "join",
  { completed, name, total }: SourceProgress,
) {
  const half = stage === "read" ? 0 : 50

  notices.raise({
    // Stop asks the reading to end; the files going in finish together.
    action: stage === "read" ? { kind: "fileAddStop" } : undefined,
    kind: "filesMerging",
    owner: workspaceOwner,
    progress: { completed: half + Math.round((completed / total) * 50), total: 100 },
    values: { current: completed + 1, name, total },
  })
}

/** The read's bar handed on to the files going in, without the Stop that no
    longer stops anything, or ended where too few were read to show one. */
function settleReadProgress(notices: NoticeChannel, read: FileSourceInfo[]) {
  if (read.length >= PROGRESS_FROM) {
    raiseFilesProgress(notices, "join", {
      completed: 0,
      name: fileNameFromPath(read[0].path),
      total: read.length,
    })
  } else {
    endFilesProgress(notices)
  }
}

/** Puts the files read in, the corner naming each as it goes once there are
    many: what `insert_pdf_files` and `merge_pdf_sources` take as `onProgress`. */
export function joinProgress(notices: NoticeChannel, count: number) {
  return filesProgress(notices, count, "join")
}

/** The bar's end, however the add or merge ended. */
export function endFilesProgress(notices: NoticeChannel) {
  notices.retract(workspaceOwner, ["filesMerging"])
}

/**
 * Reads files for their pages into the window's source list, which a
 * document's added files take their pages from. Past what one go takes, the
 * reader is asked first whether to go on with the files that fit. An office
 * suite may take minutes, so a conversion offers Stop in the corner, as a long
 * run's bar does; files that could not be read are named there. Resolves to
 * those read.
 */
export async function readFileSources(
  asked: string[],
  notices: NoticeChannel,
  askLimit: AskBatchLimit,
): Promise<FileSourceInfo[]> {
  const raise = (kind: NoticeKind, values: Record<string, string | number>) =>
    notices.raise({ kind, owner: workspaceOwner, values })
  const sizes = await invoke<number[]>("source_sizes", { paths: asked }).catch(() =>
    asked.map(() => 0),
  )
  const limit = mergeLimit(sizes)

  // Asked even when none fits, which the prompt says: never dropped silently.
  if (limit && (!(await askLimit(limit)) || limit.fit === 0)) {
    return []
  }

  const paths = limit ? asked.slice(0, limit.fit) : asked
  const converting = paths.some(isWordPath) && paths.length < PROGRESS_FROM

  if (converting) {
    notices.raise({
      action: { kind: "fileAddStop" },
      kind: "fileAdding",
      owner: workspaceOwner,
    })
  }

  let read: FileSourceInfo[] = []

  try {
    const infos = await invoke<FileSourceInfo[]>("read_pdf_sources", {
      onProgress: filesProgress(notices, paths.length, "read"),
      paths,
    })
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

    read = infos.filter((info) => info.id !== undefined && info.pages.length > 0)

    return read
  } catch (error) {
    raise(
      String(error).includes("at most") ? "filesTooMany" : "filesUnreadable",
      { count: paths.length, names: paths.map(fileNameFromPath).join(", ") },
    )

    return []
  } finally {
    settleReadProgress(notices, read)

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

  return { smartPadding: preferences.smartPadding }
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
  {
    ask,
    askLimit,
    notices,
    ownTitle,
  }: { ask: AskSignatures; askLimit: AskBatchLimit; notices: NoticeChannel; ownTitle: string },
): Promise<MergedFiles> {
  try {
    return await mergeRead(await readFileSources(paths, notices, askLimit), {
      ask,
      notices,
      ownTitle,
    })
  } finally {
    endFilesProgress(notices)
  }
}

async function mergeRead(
  read: FileSourceInfo[],
  { ask, notices, ownTitle }: { ask: AskSignatures; notices: NoticeChannel; ownTitle: string },
): Promise<MergedFiles> {
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
      onProgress: joinProgress(notices, read.length),
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
