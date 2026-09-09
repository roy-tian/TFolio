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
 * How a note's text is drawn. There is no family to pick: Latin text is drawn
 * in Helvetica, and anything else in whichever face the machine can embed, so
 * a control here would offer a choice a note might not be given.
 */
export type TextNoteStyle = {
  color: HexColor
  /** Point size, as a PDF measures type. */
  fontSize: number
  opacity: number
}

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
  /** The history entry's own id; the undo's delete stashes under it, and a
      redo's delete replaces that stash rather than colliding with it. */
  stashId: number
}

/**
 * Inserts another PDF's pages into the document at `index`, as one edit. The
 * backend holds one document from then on: the pages are the document's own,
 * indistinguishable from the rest except to the save guard, which keeps a
 * document holding another file's pages export-only.
 *
 * `insertedCount` is 0 until the first apply reads the file — the frontend
 * cannot know how many pages the file has until the backend has opened it — and
 * `pageCount` grows by it then. A redo does not re-read the file (it restores
 * the pages the undo stashed), so by then both are known.
 */
export type InsertFileCommand = {
  kind: "insertFile"
  /** The approved path the insert reads, as an undone/redone insert would. */
  path: string
  /** 1-based position the file's first page takes, from 1 to page count + 1. */
  index: number
  /** Pages the file brought; 0 until the first apply learns it. */
  insertedCount: number
  /** Pages in the document after the insertion; the count before it until the
      first apply learns how many the file brings. */
  pageCount: number
  /** The history entry's own id: the undo deletes the inserted range under it,
      and the redo restores exactly that stash. */
  stashId: number
}

/**
 * Copies pages out of another open document at `index`, as one edit — the
 * thumbnail drag that crosses tabs. Like an inserted file's, the pages become
 * this document's own and leave it export-only; unlike one, they are read from
 * a document the reader has open rather than from a file, so they arrive with
 * whatever that session has made of them.
 *
 * The source is named for the apply alone. A redo restores the pages the undo
 * stashed rather than reading them across again, so the document they came from
 * may be closed, or moved on, by then.
 */
export type InsertPagesCommand = {
  kind: "insertPages"
  /** 1-based position the first copied page takes, from 1 to page count + 1. */
  index: number
  /** Pages in the document after the insertion. */
  pageCount: number
  sourceDocumentId: number
  /** Ascending 1-based page numbers, as the source document stands. */
  sourcePages: number[]
  /** The history entry's own id: the undo deletes the copied range under it,
      and the redo restores exactly that stash. */
  stashId: number
}

/**
 * Copies pages of this document back into it at `index`, as one edit — the
 * grid's copy-and-paste. The copies are the document's own content, so unlike
 * an inserted file's pages they leave it saveable, and the backend needs no
 * second document to read them from.
 *
 * `sourcePages` are the numbers the pages had before the copies landed. A redo
 * restores the pages the undo stashed rather than copying them again, so they
 * never have to mean anything at a later moment.
 */
export type DuplicatePagesCommand = {
  kind: "duplicatePages"
  /** 1-based position the first copy takes, from 1 to page count + 1. */
  index: number
  /** Pages in the document after the copies landed. */
  pageCount: number
  /** Ascending 1-based page numbers, as the document stood before the paste. */
  sourcePages: number[]
  /** The history entry's own id: the undo deletes the copied range under it,
      and the redo restores exactly that stash. */
  stashId: number
}

/**
 * A mark the reader rubbed out with the eraser.
 *
 * The entry that made it is carried whole rather than pointed at: an undo
 * re-applies exactly that command and puts the entry back at the position it
 * was taken from, so the history keeps reading in the order the marks were
 * made — and every other entry's undo still finds its own annotations, which
 * it knows by id rather than by where they sit on the page.
 */
export type EraseAnnotationCommand = {
  kind: "eraseAnnotation"
  /** Where `target` sat in the applied history, for an undo to splice it back
      into. LIFO undo has already taken back everything above it by then, so the
      position still means what it did. */
  index: number
  /** The page each of the entry's annotations was really on when it went — the
      backend's answer, since a structure edit may have renumbered the pages the
      command itself names. Empty until the first apply reports them. */
  pages: number[]
  target: AnnotationEntry
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
  | InsertFileCommand
  | InsertPagesCommand
  | DuplicatePagesCommand
  | EraseAnnotationCommand

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

/** Pages `index` through `pageCount`, both 1-based; empty when the range starts
    past the end. */
function pagesFrom(index: number, pageCount: number): number[] {
  return Array.from(
    { length: Math.max(0, pageCount - index + 1) },
    (_, offset) => index + offset,
  )
}

/** The positions a reorder actually changes the content of: slot `i + 1` shows
    a different page only when `order` does not leave it holding its own number.
    A permutation and its inverse fix exactly the same slots, so this answers
    for the undo as well as the apply. */
function movedPositions(order: number[]): number[] {
  const moved: number[] = []

  for (let index = 0; index < order.length; index += 1) {
    if (order[index] !== index + 1) {
      moved.push(index + 1)
    }
  }

  return moved
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
      return movedPositions(command.order)
    case "deletePages":
      // From the first page taken out: every page ahead of it keeps both its
      // number and its pixels. `pageCount` is the count before the delete — the
      // larger shape — so the same range covers the undo's restore.
      return pagesFrom(Math.min(...command.pages), command.pageCount)
    case "insertBlankPage":
      // From the gap on, as an inserted file is, and against the count after
      // the insertion — again the larger of the two shapes.
      return pagesFrom(command.index, command.pageCount)
    case "insertFile":
    case "insertPages":
    case "duplicatePages":
      // Only from the gap on: a page ahead of it keeps both its number and its
      // pixels, so a block appended at the very end invalidates nothing. A
      // file's `pageCount` is the count before it was read and the count after
      // once the apply has learned it — a dragged block knows its own from the
      // start — so one expression covers the apply and the undo of either.
      return pagesFrom(command.index, command.pageCount)
    case "eraseAnnotation":
      // What the backend reported, once it has: the erased entry's own page
      // numbers are the ones it was made with, which a structure edit since may
      // have moved.
      return command.pages.length > 0
        ? command.pages
        : commandPages(command.target.command)
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
    case "insertFile":
    case "insertPages":
    case "duplicatePages":
      return true
    case "highlight":
    case "rect":
    case "textNote":
    case "watermark":
    case "pageNumbers":
    // Only ever a mark, which is why the eraser can take one from the middle of
    // the history without the pages beneath it moving.
    case "eraseAnnotation":
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
    case "insertFile":
    case "insertPages":
    case "duplicatePages":
      return commandPages(command)
    default:
      return []
  }
}

/**
 * Plans an erase of the mark entry `entryId` made: it leaves the applied
 * history, and an entry recording where it stood takes its place at the top.
 *
 * An entry no longer applied — the reader undid it between the hit test and
 * this — is nothing to erase.
 */
export function planEraseAnnotation(history: AnnotationHistory, entryId: number) {
  const index = history.past.findIndex((entry) => entry.id === entryId)

  if (index < 0) {
    return null
  }

  const command: EraseAnnotationCommand = {
    index,
    kind: "eraseAnnotation",
    pages: [],
    target: history.past[index]!,
  }

  return {
    command,
    history: {
      future: [],
      nextId: history.nextId + 1,
      past: [
        ...history.past.slice(0, index),
        ...history.past.slice(index + 1),
        { command, id: history.nextId },
      ],
      savedId: history.savedId,
    } satisfies AnnotationHistory,
  }
}

/** Records where the erased annotations actually were, which only the apply
    learns — the counterpart of `fillInsertFileOutcome`. */
export function fillErasedPages(
  history: AnnotationHistory,
  entryId: number,
  pages: number[],
): AnnotationHistory {
  return {
    ...history,
    past: history.past.map((entry) =>
      entry.id === entryId && entry.command.kind === "eraseAnnotation"
        ? { ...entry, command: { ...entry.command, pages } }
        : entry,
    ),
  }
}

/**
 * `command` with its page numbers replaced by the pages its annotations were
 * really on — one per annotation, in the order the command wrote them. What
 * puts an erased mark back where it was rather than where it was first made,
 * across a structure edit that renumbered the pages in between.
 */
export function retargetCommand(
  command: AnnotationCommand,
  pages: number[],
): AnnotationCommand {
  if (pages.length === 0) {
    return command
  }

  switch (command.kind) {
    case "highlight":
      return {
        ...command,
        targets: command.targets.map((target, index) => ({
          ...target,
          pageNumber: pages[index] ?? target.pageNumber,
        })),
      }
    case "rect":
    case "textNote":
      return { ...command, pageNumber: pages[0] ?? command.pageNumber }
    default:
      return command
  }
}

/** `count` consecutive page numbers from `index`. */
function pageRange(index: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => index + offset)
}

/** The pages an insert's undo deletes, and its redo restores: the file's own
    range, valid at the LIFO moment the insert sits at the top of history. */
export function insertFilePages(command: InsertFileCommand): number[] {
  return pageRange(command.index, command.insertedCount)
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
) {
  if (index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertBlankPageCommand = {
    index,
    kind: "insertBlankPage",
    pageCount: pageCount + 1,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** Plans an insert. `insertedCount` stays 0 here and `pageCount` is the count
    before the insert: the file has not been read yet, so both are settled once
    the first apply learns how many pages it brings (see
    `fillInsertFileOutcome`). The position is the reader's, so an out-of-range
    one is refused here rather than clamped. */
export function planInsertFile(
  history: AnnotationHistory,
  path: string,
  index: number,
  pageCount: number,
) {
  if (index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertFileCommand = {
    index,
    insertedCount: 0,
    kind: "insertFile",
    pageCount,
    path,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** Rewrites the insert the first apply just committed with the page count the
    backend reported — the one fact an insert learns only after reading the file.
    An undo's delete then reads the range as if it had been known all along. */
export function fillInsertFileOutcome(
  history: AnnotationHistory,
  entryId: number,
  insertedCount: number,
): AnnotationHistory {
  return {
    ...history,
    past: history.past.map((entry) =>
      entry.id === entryId && entry.command.kind === "insertFile"
        ? {
            ...entry,
            command: {
              ...entry.command,
              insertedCount,
              pageCount: entry.command.pageCount + insertedCount,
            },
          }
        : entry,
    ),
  }
}

/** The pages a copied block's undo deletes, and its redo restores — a drag from
    another tab or a paste of this document's own pages — valid at the LIFO
    moment that insert sits at the top of history. */
export function insertPagesRange(
  command: InsertPagesCommand | DuplicatePagesCommand,
): number[] {
  return pageRange(command.index, command.sourcePages.length)
}

/** Plans a cross-document insert. The position is the reader's, so an
    out-of-range one is refused here rather than clamped; the pages are the
    source grid's, and the backend checks them against the document they name. */
export function planInsertPages(
  history: AnnotationHistory,
  sourceDocumentId: number,
  sourcePages: number[],
  index: number,
  pageCount: number,
) {
  const pages = [...new Set(sourcePages)].sort((left, right) => left - right)

  if (pages.length === 0 || index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertPagesCommand = {
    index,
    kind: "insertPages",
    pageCount: pageCount + pages.length,
    sourceDocumentId,
    sourcePages: pages,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** Plans a paste of the document's own pages. The position is the reader's, so
    an out-of-range one is refused here rather than clamped; the pages are the
    grid's, and the backend checks them against the document they name. */
export function planDuplicatePages(
  history: AnnotationHistory,
  sourcePages: number[],
  index: number,
  pageCount: number,
) {
  const pages = [...new Set(sourcePages)].sort((left, right) => left - right)

  if (pages.length === 0 || index < 1 || index > pageCount + 1) {
    return null
  }

  const command: DuplicatePagesCommand = {
    index,
    kind: "duplicatePages",
    pageCount: pageCount + pages.length,
    sourcePages: pages,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
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

/** The command the next undo would take back; null when there is none. */
export function nextUndoCommand(history: AnnotationHistory) {
  return history.past.at(-1)?.command ?? null
}

/** The command the next redo would apply again; null when there is none. */
export function nextRedoCommand(history: AnnotationHistory) {
  return history.future.at(-1)?.command ?? null
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

  const past = history.past.slice(0, -1)

  // Taking back an erase gives the mark's own entry its place back, so the
  // history reads in the order the marks were made whichever way it is walked.
  if (entry.command.kind === "eraseAnnotation") {
    past.splice(entry.command.index, 0, entry.command.target)
  }

  return {
    entry,
    history: {
      future: [...history.future, entry],
      nextId: history.nextId,
      past,
      savedId: history.savedId,
    },
  }
}

export function redo(history: AnnotationHistory) {
  const entry = history.future.at(-1)

  if (!entry) {
    return null
  }

  const erased =
    entry.command.kind === "eraseAnnotation" ? entry.command.target.id : null

  return {
    entry,
    history: {
      future: history.future.slice(0, -1),
      nextId: history.nextId,
      past: [
        ...(erased === null
          ? history.past
          : history.past.filter((applied) => applied.id !== erased)),
        entry,
      ],
      savedId: history.savedId,
    },
  }
}

export function markSaved(history: AnnotationHistory): AnnotationHistory {
  return { ...history, savedId: historyHead(history) }
}
