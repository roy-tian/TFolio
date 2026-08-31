import type { PagePoint, PagePointsRect } from "@/lib/annotationGeometry"
import {
  samePageNumbersConfig,
  type PageNumbersConfig,
} from "@/lib/pageNumbers"
import { sameWatermarkConfig, type WatermarkConfig } from "@/lib/watermark"

/** A colour as `#rrggbb`, the form `<input type="color">` reads and writes. */
export type HexColor = string

/** Times each page has changed. A page never drawn on is absent, not zero. */
export type RenderEpochs = Record<number, number>

export type HighlightTarget = {
  pageNumber: number
  quads: PagePointsRect[]
}

/**
 * A selection dragged across a page break covers several pages but is still one
 * action, so it stays one command and one undo — the backend just writes an
 * annotation per page it touches.
 */
export type HighlightCommand = {
  color: HexColor
  kind: "highlight"
  /** 0..1, kept apart from the colour so the picker can stay a plain hex. */
  opacity: number
  targets: HighlightTarget[]
}

/**
 * The rectangle tool's persisted settings. One drag draws one block, and the
 * effect decides what fills it: a translucent wash of `color` at `opacity`, or
 * the page's own pixels blurred or squared off at `strength` page points. The
 * settings the showing effect does not use are kept rather than dropped, so
 * switching back returns the reader to what they had.
 */
export type RectStyle = {
  color: HexColor
  effect: RectEffectKind
  /** 0..1, kept apart from the colour so the picker can stay a plain hex. */
  opacity: number
  /** Blur sigma or mosaic block size, in page points. */
  strength: number
}

export type RectEffectKind = "translucent" | "blur" | "mosaic"

/**
 * The effects that rebuild the rectangle from the pixels under it. They read
 * the page rather than paint over it, which is why the colour has nothing to
 * say about them, and why they take a different path into the backend.
 */
export type RectPixelEffect = {
  kind: Exclude<RectEffectKind, "translucent">
  strength: number
}

/**
 * A rectangle is drawn on one page in one drag, so unlike a highlight it never
 * spans pages: one command, one page, one annotation.
 */
export type RectCommand = {
  bounds: PagePointsRect
  kind: "rect"
  pageNumber: number
  style: RectStyle
}

/**
 * How a note's text is drawn. `fontFamily` picks one of the PDF's standard
 * fonts, none of which can draw Chinese — text that needs the bundled face is
 * drawn in it whatever this says, which is why the control is disabled for it.
 */
export type TextNoteStyle = {
  color: HexColor
  fontFamily: TextNoteFontFamily
  /** Point size, as a PDF measures type. */
  fontSize: number
  opacity: number
}

export type TextNoteFontFamily = "sans" | "serif" | "mono"

/**
 * A note is typed at one point on one page, so like a rectangle it is one
 * command, one page, one annotation. `origin` is the top-left of the text, which
 * is where the reader clicked — not the baseline the backend draws from.
 */
export type TextNoteCommand = {
  kind: "textNote"
  origin: PagePoint
  pageNumber: number
  style: TextNoteStyle
  text: string
}

export type WatermarkCommand = {
  /** `null` is an explicit request to remove this session's watermark. */
  config: WatermarkConfig | null
  kind: "watermark"
  pageCount: number
  /** The configuration an undo restores, derived inside the mutation queue. */
  previous: WatermarkConfig | null
}

export type PageNumbersCommand = {
  /** `null` is an explicit request to remove this session's page numbers. */
  config: PageNumbersConfig | null
  kind: "pageNumbers"
  pageCount: number
  /** The configuration an undo restores, derived inside the mutation queue. */
  previous: PageNumbersConfig | null
}

/**
 * Rearranges the whole document: `order` holds the current 1-based page
 * numbers in their new sequence. Both permutations are recorded because the
 * page numbers they speak of are only meaningful at their own moment — which
 * LIFO undo guarantees is the moment they run.
 */
export type ReorderPagesCommand = {
  kind: "reorderPages"
  order: number[]
  /** The permutation that puts the pages back, for undo. */
  inverse: number[]
}

export type DeletePagesCommand = {
  kind: "deletePages"
  /** Ascending 1-based page numbers, as the document stood before deleting. */
  pages: number[]
  /** Pages in the document before the deletion. */
  pageCount: number
  /** The history entry's own id: the delete stashes the pages under it, and
      the undo restores exactly that stash. */
  stashId: number
}

export type InsertBlankPageCommand = {
  kind: "insertBlankPage"
  /** 1-based position the blank page takes, from 1 to page count + 1. */
  index: number
  /** Pages in the document after the insertion. */
  pageCount: number
  /** Whether this is a smart-parity pad — a blank page inserted before a file
      whose first page would otherwise land on an even position. Accounting
      only; the backend inserts an ordinary blank page either way. */
  pad?: boolean
  /** The history entry's own id; the undo's delete stashes under it, and a
      redo's delete replaces that stash rather than colliding with it. */
  stashId: number
}

/**
 * Appends another PDF's pages to the end of the document, as one merge. The
 * backend holds a single merged document; a "file" is only the frontend's
 * accounting of a page range, derived from these commands (see `fileRanges`).
 *
 * `insertedAt` and `pageCount` are 0 until the first apply reads the file: the
 * frontend cannot know how many pages the file has, nor exactly where they
 * land, until the backend has opened it. A redo does not re-read the file — it
 * restores the pages the undo stashed — so by then both are known.
 */
export type MergeFileCommand = {
  kind: "mergeFile"
  /** The approved path the merge reads, as an undone/redone merge would. */
  path: string
  /** The file's display name, for its card. */
  name: string
  /** 1-based position the file's first page took; 0 until the first apply. */
  insertedAt: number
  /** Pages the file brought; 0 until the first apply learns it. */
  pageCount: number
  /** The history entry's own id: the undo deletes the appended range under it,
      and the redo restores exactly that stash. */
  stashId: number
}

export type AnnotationCommand =
  | HighlightCommand
  | RectCommand
  | TextNoteCommand
  | WatermarkCommand
  | PageNumbersCommand
  | ReorderPagesCommand
  | DeletePagesCommand
  | InsertBlankPageCommand
  | MergeFileCommand

/**
 * Redoing re-runs the command and gets a fresh annotation out of PDFium, but it
 * is still the same entry in the reader's history, so the id survives.
 */
export type AnnotationEntry = {
  command: AnnotationCommand
  id: number
}

export type AnnotationHistory = {
  future: AnnotationEntry[]
  nextId: number
  past: AnnotationEntry[]
  /** The entry the document on disk ends at; 0 for a file with none of these. */
  savedId: number
}

export const emptyHistory: AnnotationHistory = {
  future: [],
  nextId: 1,
  past: [],
  savedId: 0,
}

function everyPage(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index + 1)
}

/** The pages a command writes to, and so the pages an undo has to take back. */
export function commandPages(command: AnnotationCommand): number[] {
  switch (command.kind) {
    case "highlight":
      return command.targets.map((target) => target.pageNumber)
    case "rect":
    case "textNote":
      return [command.pageNumber]
    case "watermark":
    case "pageNumbers":
      return everyPage(command.pageCount)
    case "reorderPages":
      return everyPage(command.order.length)
    case "deletePages":
    case "insertBlankPage":
      // The larger of the before and after counts, so both the apply and the
      // undo invalidate every page number either shape of the document has.
      return everyPage(command.pageCount)
    case "mergeFile":
      // A merge only appends: no page number that already existed changes its
      // pixels or its text, and the new pages get fresh components that fetch
      // on mount. Its undo (a tail delete) and redo (a restore) touch only
      // those same tail pages, so there is nothing to invalidate either way.
      return []
  }
}

/**
 * Whether applying, undoing, or redoing this command shifts the document's
 * pages — the four structure commands do; an annotation or watermark leaves
 * every page where it was. Read where a page-numbered draft (a text note being
 * typed) must be settled before a page moves out from under it, but left alone
 * when the edit cannot touch it.
 */
export function movesPages(command: AnnotationCommand): boolean {
  switch (command.kind) {
    case "reorderPages":
    case "deletePages":
    case "insertBlankPage":
    case "mergeFile":
      return true
    case "highlight":
    case "rect":
    case "textNote":
    case "watermark":
    case "pageNumbers":
      return false
  }
}

/** Pages whose selectable page-content text changed, not merely their pixels. */
export function commandTextPages(command: AnnotationCommand): number[] {
  switch (command.kind) {
    case "watermark":
    // Page numbers write page-content text, the same as a watermark.
    case "pageNumbers":
    // Structure changes move every page's extractable text somewhere else.
    case "reorderPages":
    case "deletePages":
    case "insertBlankPage":
      return commandPages(command)
    default:
      return []
  }
}

/** The pages a merge's undo deletes, and its redo restores: the appended file's
    range, valid at the LIFO moment the merge sits at the top of history. */
export function mergeFilePages(command: MergeFileCommand): number[] {
  return Array.from(
    { length: command.pageCount },
    (_, offset) => command.insertedAt + offset,
  )
}

/** The permutation that undoes `order`; both are 1-based page sequences. */
export function inversePermutation(order: number[]): number[] {
  const inverse = new Array<number>(order.length)

  order.forEach((pageNumber, index) => {
    inverse[pageNumber - 1] = index + 1
  })

  return inverse
}

export function isIdentityOrder(order: number[]) {
  return order.every((pageNumber, index) => pageNumber === index + 1)
}

/** Plans a reorder from the history the mutation queue reached; the identity
    order is dropped here so it never occupies an undo step. */
export function planReorderPages(history: AnnotationHistory, order: number[]) {
  if (isIdentityOrder(order)) {
    return null
  }

  const command: ReorderPagesCommand = {
    inverse: inversePermutation(order),
    kind: "reorderPages",
    order,
  }

  return { command, history: commit(history, command) }
}

/** Plans a deletion. The stash takes the entry's own id, which is what pairs
    this delete with exactly its undo's restore. */
export function planDeletePages(
  history: AnnotationHistory,
  pages: number[],
  pageCount: number,
) {
  const sorted = [...new Set(pages)].sort((left, right) => left - right)

  if (sorted.length === 0 || sorted.length >= pageCount) {
    return null
  }

  const command: DeletePagesCommand = {
    kind: "deletePages",
    pageCount,
    pages: sorted,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

export function planInsertBlankPage(
  history: AnnotationHistory,
  index: number,
  pageCount: number,
  pad = false,
) {
  if (index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertBlankPageCommand = {
    index,
    kind: "insertBlankPage",
    pageCount: pageCount + 1,
    // Omit the flag entirely when false, so an ordinary insert's command stays
    // exactly what it was before parity padding existed.
    ...(pad ? { pad: true } : {}),
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** Plans a merge. `insertedAt`/`pageCount` stay 0 here: the file has not been
    read yet, so both are filled in once the first apply learns them (see
    `fillMergeOutcome`). A merge always happens, so this never returns null. */
export function planMergeFile(
  history: AnnotationHistory,
  path: string,
  name: string,
) {
  const command: MergeFileCommand = {
    insertedAt: 0,
    kind: "mergeFile",
    name,
    pageCount: 0,
    path,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** Rewrites the merge the first apply just committed with the position and page
    count the backend reported — the two facts a merge learns only after reading
    the file. Later replays (`fileRanges`, an undo's delete) then read them as if
    they had been known all along. */
export function fillMergeOutcome(
  history: AnnotationHistory,
  entryId: number,
  insertedAt: number,
  pageCount: number,
): AnnotationHistory {
  return {
    ...history,
    past: history.past.map((entry) =>
      entry.id === entryId && entry.command.kind === "mergeFile"
        ? { ...entry, command: { ...entry.command, insertedAt, pageCount } }
        : entry,
    ),
  }
}

/** The active session watermark implied by the applied side of history. */
export function watermarkConfig(
  history: AnnotationHistory,
): WatermarkConfig | null {
  for (let index = history.past.length - 1; index >= 0; index -= 1) {
    const command = history.past[index]!.command

    if (command.kind === "watermark") {
      // An explicit remove is authoritative. Looking farther back would revive
      // a configuration the document no longer carries.
      return command.config
    }
  }

  return null
}

/** Plans a document-level change from the history the mutation queue reached. */
export function planWatermarkChange(
  history: AnnotationHistory,
  config: WatermarkConfig | null,
  pageCount: number,
) {
  const previous = watermarkConfig(history)

  if (sameWatermarkConfig(previous, config)) {
    return null
  }

  const command: WatermarkCommand = {
    config,
    kind: "watermark",
    pageCount,
    previous,
  }

  return { command, history: commit(history, command) }
}

/** The active session page numbers implied by the applied side of history. */
export function pageNumbersConfig(
  history: AnnotationHistory,
): PageNumbersConfig | null {
  for (let index = history.past.length - 1; index >= 0; index -= 1) {
    const command = history.past[index]!.command

    if (command.kind === "pageNumbers") {
      // An explicit remove is authoritative, exactly as for a watermark.
      return command.config
    }
  }

  return null
}

/** Plans a page-number change from the history the mutation queue reached. */
export function planPageNumbersChange(
  history: AnnotationHistory,
  config: PageNumbersConfig | null,
  pageCount: number,
) {
  const previous = pageNumbersConfig(history)

  if (samePageNumbersConfig(previous, config)) {
    return null
  }

  const command: PageNumbersCommand = {
    config,
    kind: "pageNumbers",
    pageCount,
    previous,
  }

  return { command, history: commit(history, command) }
}

/** The entry the document currently ends at, or 0 when nothing is applied. */
export function historyHead(history: AnnotationHistory) {
  return history.past.at(-1)?.id ?? 0
}

export function canUndo(history: AnnotationHistory) {
  return history.past.length > 0
}

export function canRedo(history: AnnotationHistory) {
  return history.future.length > 0
}

/**
 * Identity of the topmost entry rather than a count of edits: undoing back to
 * exactly what was saved leaves nothing to write, which a counter — only ever
 * growing — would report as dirty forever after the first edit.
 */
export function isDirty(history: AnnotationHistory) {
  return historyHead(history) !== history.savedId
}

/** Anything undone is dropped: the reader has taken a new branch. */
export function commit(
  history: AnnotationHistory,
  command: AnnotationCommand,
): AnnotationHistory {
  return {
    future: [],
    nextId: history.nextId + 1,
    past: [...history.past, { command, id: history.nextId }],
    savedId: history.savedId,
  }
}

export function undo(history: AnnotationHistory) {
  const entry = history.past.at(-1)

  if (!entry) {
    return null
  }

  return {
    entry,
    history: {
      future: [...history.future, entry],
      nextId: history.nextId,
      past: history.past.slice(0, -1),
      savedId: history.savedId,
    },
  }
}

export function redo(history: AnnotationHistory) {
  const entry = history.future.at(-1)

  if (!entry) {
    return null
  }

  return {
    entry,
    history: {
      future: history.future.slice(0, -1),
      nextId: history.nextId,
      past: [...history.past, entry],
      savedId: history.savedId,
    },
  }
}

export function markSaved(history: AnnotationHistory): AnnotationHistory {
  return { ...history, savedId: historyHead(history) }
}
