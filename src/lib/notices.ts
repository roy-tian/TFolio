/**
 * The corner is for what the reader has moved on from; what is still on screen
 * keeps its message where it was caused.
 */

import type { ParseKeys } from "i18next"

import type { PdfProgress } from "@/lib/progress"
import type { AppUpdateStatus } from "@/lib/update"

export const NOTICE_LIFE_MS = 5_000

/** A standing notice is never dropped for the count: each one is an offer,
    and there is no answering what is gone. */
export const NOTICE_LIMIT = 3

/** Red is for work that broke: something was attempted and could not be done.
    Amber is for a condition — nothing was lost, and the way on is in the words. */
export type NoticeTone = "danger" | "info" | "success" | "warning"

export type NoticeLife = "standing" | "transient"

export type NoticeOwner =
  | { documentId: number; scope: "document" }
  | { scope: "workspace" }

export const workspaceOwner: NoticeOwner = { scope: "workspace" }

/** Named rather than passed as a function, so a notice stays a plain value:
    the work belongs to whoever can still do it. */
export type NoticeActionKind =
  | "noteFont"
  | "updateDownload"
  | "updateInstall"
  | "updateRetry"

export type NoticeAction = {
  busy?: boolean
  kind: NoticeActionKind
}

type NoticeEntry = {
  detailKey?: ParseKeys
  life: NoticeLife
  /** What this notice replaces, where that is not itself: the grid's six
      clipboard notices are one running report, not six that stand together. */
  slot?: string
  textKey: ParseKeys
  tone: NoticeTone
}

export const noticeCatalogue = {
  annotateFailed: {
    life: "transient",
    textKey: "annotate.failed",
    tone: "danger",
  },
  createFailed: { life: "transient", textKey: "menu.newFailed", tone: "danger" },
  editInFlight: {
    life: "transient",
    textKey: "annotate.dropWhileEditing",
    tone: "warning",
  },
  exportFailed: {
    life: "transient",
    textKey: "annotate.exportFailed",
    tone: "danger",
  },
  fileTooLarge: {
    life: "transient",
    textKey: "viewer.fileTooLarge",
    tone: "warning",
  },
  invalidFile: {
    life: "transient",
    textKey: "viewer.invalidFile",
    tone: "warning",
  },
  newWindowFailed: {
    life: "transient",
    textKey: "menu.newWindowFailed",
    tone: "danger",
  },
  // Two words for one held edit: the failed fetch replaces the offer that led
  // to it rather than standing beside it, and turns it red on the way.
  noteFontFailed: {
    life: "standing",
    slot: "noteFont",
    textKey: "annotate.noteFontFailed",
    tone: "danger",
  },
  noteFontMissing: {
    life: "standing",
    slot: "noteFont",
    textKey: "annotate.noteFontMissing",
    tone: "warning",
  },
  openFailed: { life: "transient", textKey: "viewer.openFailed", tone: "danger" },
  pagesCopied: {
    life: "transient",
    slot: "pageClipboard",
    textKey: "pageEdit.copiedNotice",
    tone: "info",
  },
  pagesCut: {
    life: "transient",
    slot: "pageClipboard",
    textKey: "pageEdit.cutNotice",
    tone: "info",
  },
  pagesMoved: {
    life: "transient",
    slot: "pageClipboard",
    textKey: "pageEdit.movedNotice",
    tone: "info",
  },
  pagesMovedToEnd: {
    life: "transient",
    slot: "pageClipboard",
    textKey: "pageEdit.movedAtEndNotice",
    tone: "info",
  },
  pagesPasted: {
    life: "transient",
    slot: "pageClipboard",
    textKey: "pageEdit.pastedNotice",
    tone: "info",
  },
  pagesPastedToEnd: {
    life: "transient",
    slot: "pageClipboard",
    textKey: "pageEdit.pastedAtEndNotice",
    tone: "info",
  },
  printFailed: { life: "transient", textKey: "print.failed", tone: "danger" },
  saveFailed: {
    life: "transient",
    textKey: "annotate.saveFailed",
    tone: "danger",
  },
  // The release check is one slot the backend's status moves through, so a
  // download that starts replaces the offer to start it.
  updateAvailable: {
    life: "standing",
    slot: "update",
    textKey: "update.available",
    tone: "success",
  },
  updateDownloading: {
    life: "standing",
    slot: "update",
    textKey: "update.downloading",
    tone: "success",
  },
  updateFailed: {
    life: "standing",
    slot: "update",
    textKey: "update.failed",
    tone: "danger",
  },
  // The whole notice turns, not only the line that says so: a download that
  // never arrived and an install the platform refused are the same news.
  updateInstallFailed: {
    detailKey: "update.installFailed",
    life: "standing",
    slot: "update",
    textKey: "update.ready",
    tone: "danger",
  },
  updateReady: {
    life: "standing",
    slot: "update",
    textKey: "update.ready",
    tone: "success",
  },
  wordUnavailable: {
    life: "transient",
    textKey: "viewer.wordUnavailable",
    tone: "warning",
  },
} as const satisfies Record<string, NoticeEntry>

export type NoticeKind = keyof typeof noticeCatalogue

export const noticeActions = {
  noteFont: {
    busyLabelKey: "annotate.noteFontFetching",
    labelKey: "annotate.noteFontFetch",
  },
  updateDownload: { labelKey: "update.download" },
  updateInstall: { labelKey: "update.install" },
  updateRetry: { labelKey: "update.retry" },
} as const satisfies Record<
  NoticeActionKind,
  { busyLabelKey?: ParseKeys; labelKey: ParseKeys }
>

/** A mark that lands puts every refusal behind the reader; the grid's
    clipboard notices report what worked, and nothing later disproves them. */
export const documentRefusals = [
  "annotateFailed",
  "editInFlight",
  "exportFailed",
  "noteFontFailed",
  "noteFontMissing",
  "printFailed",
  "saveFailed",
] as const satisfies readonly NoticeKind[]

/** What a finished open batch disproves, whichever of them it raised. */
export const openRefusals = [
  "fileTooLarge",
  "invalidFile",
  "openFailed",
  "wordUnavailable",
] as const satisfies readonly NoticeKind[]

export type NoticeValues = Record<string, number | string>

/** What a raiser says. The tone, the life and the words come from the
    catalogue; only what the catalogue cannot know is passed. */
export type NoticeInput = {
  action?: NoticeAction
  kind: NoticeKind
  owner: NoticeOwner
  /** Present on a notice that carries a bar, null while the work has no
      announced length. Absent from every notice that carries none. */
  progress?: PdfProgress | null
  values?: NoticeValues
}

export type Notice = NoticeInput & {
  /** Slot and owner together: the same refusal about two documents is two
      notices, and the same refusal twice about one document is still one. */
  id: string
  /** Where it sits in its group, kept while the slot stays occupied so a
      repeat does not jump the queue it is already in. */
  sequence: number
  /** Bumped by every raise, and nothing else. What the row's clock keys on, so
      a repeat is given a full life instead of inheriting a nearly-spent one. */
  token: number
}

export function noticeEntry(kind: NoticeKind): NoticeEntry {
  return noticeCatalogue[kind]
}

export function noticeId(kind: NoticeKind, owner: NoticeOwner): string {
  const slot = noticeEntry(kind).slot ?? kind

  return owner.scope === "workspace" ? slot : `${slot}#${owner.documentId}`
}

/** The identity of one lifetime, which changes when a repeat restarts it. */
export function noticeClockKey(notice: Notice): string {
  return `${notice.id}@${notice.token}`
}

/** True for the grid's clipboard notices, which the page-edit suite reads by
    an attribute of their own. */
export function isPageNotice(kind: NoticeKind): boolean {
  return noticeEntry(kind).slot === "pageClipboard"
}

/** A slot already taken keeps its place in the stack and gets a new lifetime. */
export function raiseNotice(
  list: readonly Notice[],
  input: NoticeInput,
  tick: number,
): Notice[] {
  const id = noticeId(input.kind, input.owner)
  const held = list.find((notice) => notice.id === id)
  const raised: Notice = {
    ...input,
    id,
    sequence: held?.sequence ?? tick,
    token: tick,
  }

  return held
    ? list.map((notice) => (notice.id === id ? raised : notice))
    : [...list, raised]
}

export function dismissNotice(list: readonly Notice[], id: string): Notice[] {
  const kept = list.filter((notice) => notice.id !== id)

  return kept.length === list.length ? (list as Notice[]) : kept
}

/** What a source takes back: everything an owner holds, or only the kinds
    named — through any kind sharing a slot, since one at most is ever up. */
export function retractNotices(
  list: readonly Notice[],
  owner: NoticeOwner,
  kinds?: readonly NoticeKind[],
): Notice[] {
  const ids = kinds
    ? new Set(kinds.map((kind) => noticeId(kind, owner)))
    : null
  const kept = list.filter((notice) =>
    ids ? !ids.has(notice.id) : !ownedBy(notice, owner),
  )

  return kept.length === list.length ? (list as Notice[]) : kept
}

function ownedBy(notice: Notice, owner: NoticeOwner): boolean {
  return owner.scope === "workspace"
    ? notice.owner.scope === "workspace"
    : notice.owner.scope === "document" &&
        notice.owner.documentId === owner.documentId
}

/**
 * The workspace's and the leading document's; another document's are held for
 * its tab, not lost. Standing rows lead, so a new transient moves no button.
 */
export function visibleNotices(
  list: readonly Notice[],
  activeDocumentId: number | null,
  limit = NOTICE_LIMIT,
): Notice[] {
  const { shown } = stackNotices(list, activeDocumentId, limit)

  return shown
}

/**
 * The transients this tab has no room for, which their raiser drops: a row
 * nobody sees runs no clock and would come back long after what it reports.
 */
export function overflowNotices(
  list: readonly Notice[],
  activeDocumentId: number | null,
  limit = NOTICE_LIMIT,
): Notice[] {
  const { overflow } = stackNotices(list, activeDocumentId, limit)

  return overflow
}

function stackNotices(
  list: readonly Notice[],
  activeDocumentId: number | null,
  limit: number,
): { overflow: Notice[]; shown: Notice[] } {
  const mine = list.filter(
    (notice) =>
      notice.owner.scope === "workspace" ||
      notice.owner.documentId === activeDocumentId,
  )
  const byAge = (a: Notice, b: Notice) => a.sequence - b.sequence
  const standing = mine
    .filter((notice) => noticeCatalogue[notice.kind].life === "standing")
    .sort(byAge)
  const transient = mine
    .filter((notice) => noticeCatalogue[notice.kind].life === "transient")
    .sort(byAge)
  const room = Math.max(0, limit - standing.length)
  const dropped = Math.max(0, transient.length - room)

  return {
    overflow: transient.slice(0, dropped),
    shown: [...standing, ...transient.slice(dropped)],
  }
}

/** Derived rather than raised: the backend owns the check for every window,
    so the corner shows only what it was told and what its reader waved away. */
export function updateNotice(update: {
  installFailed: boolean
  status: AppUpdateStatus
  visible: boolean
}): NoticeInput | null {
  const { installFailed, status, visible } = update

  if (!visible) {
    return null
  }

  switch (status.state) {
    case "available":
      return {
        action: { kind: "updateDownload" },
        kind: "updateAvailable",
        owner: workspaceOwner,
        values: { version: status.version },
      }
    case "downloading":
      return {
        kind: "updateDownloading",
        owner: workspaceOwner,
        progress:
          status.total === null
            ? null
            : { completed: status.received, total: status.total },
        values: { version: status.version },
      }
    case "failed":
      return {
        action: { kind: "updateRetry" },
        kind: "updateFailed",
        owner: workspaceOwner,
      }
    case "ready":
      return {
        action: { kind: "updateInstall" },
        kind: installFailed ? "updateInstallFailed" : "updateReady",
        owner: workspaceOwner,
        values: { version: status.version },
      }
    default:
      return null
  }
}
