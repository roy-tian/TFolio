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

/** A selection dragged across a page break is still one action: one command,
    one undo — the backend writes an annotation per page it touches. */
export type HighlightCommand = {
  color: HexColor
  kind: "highlight"
  /** 0..1, kept apart from the colour so the picker can stay a plain hex. */
  opacity: number
  targets: HighlightTarget[]
}

/** The rectangle tool's persisted settings; those an effect does not use are
    kept, so switching back returns the reader to what they had. */
export type RectStyle = {
  color: HexColor
  effect: RectEffectKind
  /** 0..1, kept apart from the colour so the picker can stay a plain hex. */
  opacity: number
  /** Blur sigma or mosaic block size, in page points. */
  strength: number
}

export type RectEffectKind = "translucent" | "blur" | "mosaic"

/** Rebuilds the rectangle from the pixels under it rather than painting over
    them — hence no colour, and a different path into the backend. */
export type RectPixelEffect = {
  kind: Exclude<RectEffectKind, "translucent">
  strength: number
}

/** Drawn on one page in one drag, so unlike a highlight it never spans pages:
    one command, one page, one annotation. */
export type RectCommand = {
  bounds: PagePointsRect
  kind: "rect"
  pageNumber: number
  style: RectStyle
}

/** No family to pick: Latin text draws in Helvetica, anything else in whichever
    face the machine can embed — a choice a control could not guarantee. */
export type TextNoteStyle = {
  color: HexColor
  /** Point size, as a PDF measures type. */
  fontSize: number
  opacity: number
}

/** One command, one page, one annotation, like a rectangle. `origin` is the
    text's top-left — where the reader clicked — not the baseline drawn from. */
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

/** `order` is the current 1-based page numbers in their new sequence. Both
    permutations are recorded: numbers mean something only at their LIFO moment. */
export type ReorderPagesCommand = {
  kind: "reorderPages"
  order: number[]
  inverse: number[]
}

/** Turns the file itself, not the view. The turn is a step, not a destination:
    the undo simply completes the circle, so no page's prior rotation is needed. */
export type RotatePagesCommand = {
  kind: "rotatePages"
  /** Ascending 1-based page numbers. */
  pages: number[]
  /** The clockwise turn to add, in degrees: 90, 180 or 270. */
  degrees: number
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

/** The pages become the document's own, which the save guard keeps export-only.
    Counts settle at the first apply; a redo restores the stash, never re-reads. */
export type InsertFileCommand = {
  kind: "insertFile"
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

/** The cross-tab thumbnail drag. The pages become this document's own and leave
    it export-only; a redo restores the stash, so the source may be gone by then. */
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

/** The grid's copy-and-paste. The copies are the document's own content, so it
    stays saveable; a redo restores the undo's stash rather than copying again. */
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

/** The mark-making entry is carried whole, not pointed at: an undo re-applies
    exactly that command, and every entry's undo knows its own marks by id. */
export type EraseAnnotationCommand = {
  kind: "eraseAnnotation"
  /** Where `target` sat in the applied history, for an undo to splice it back
      into — LIFO has taken back everything above by then, so it still holds. */
  index: number
  /** The page each annotation was really on when it went — the backend's
      answer, since structure edits may have renumbered the command's pages. */
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
  | RotatePagesCommand
  | DeletePagesCommand
  | InsertBlankPageCommand
  | InsertFileCommand
  | InsertPagesCommand
  | DuplicatePagesCommand
  | EraseAnnotationCommand

/** Redoing re-runs the command and gets a fresh annotation out of PDFium, but
    it is still the same entry in the reader's history, so the id survives. */
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

/** The slots a reorder actually changes the content of; a permutation and its
    inverse fix exactly the same slots, so this answers for the undo as well. */
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
    case "rotatePages":
      return command.pages
    case "deletePages":
      // From the first page taken out — pages ahead keep their number and
      // pixels; `pageCount` is the larger, pre-delete shape the undo restores.
      return pagesFrom(Math.min(...command.pages), command.pageCount)
    case "insertBlankPage":
      // From the gap on, as an inserted file is, and against the count after
      // the insertion — again the larger of the two shapes.
      return pagesFrom(command.index, command.pageCount)
    case "insertFile":
    case "insertPages":
    case "duplicatePages":
      // Only from the gap on — an append at the very end invalidates nothing.
      // `pageCount` spans before and after, covering the apply and the undo alike.
      return pagesFrom(command.index, command.pageCount)
    case "eraseAnnotation":
      // What the backend reported, once it has: the erased entry's own numbers
      // are the ones it was made with, which a structure edit may have moved.
      return command.pages.length > 0
        ? command.pages
        : commandPages(command.target.command)
  }
}

/** Whether the command shifts pages: a page-numbered draft — a note being typed
    — settles before a page moves, and is left alone when the edit cannot. */
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
    // A page turns where it stands: the numbers around it still name what they
    // did, and a draft anchored to one is still on the page it was made on.
    case "rotatePages":
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
    // A rotation moves no text: the spans keep their places in the page's own
    // space, and it is the layer drawn over them that turns.
    default:
      return []
  }
}

/** An entry no longer applied — the reader undid it between the hit test and
    this plan — is nothing to erase. */
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

/** Page numbers replaced by where the annotations really were, in the order the
    command wrote them — what puts an erased mark back across a renumbering. */
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

function pageRange(index: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => index + offset)
}

/** The pages an insert's undo deletes, and its redo restores: the file's own
    range, valid at the LIFO moment the insert sits at the top of history. */
export function insertFilePages(command: InsertFileCommand): number[] {
  return pageRange(command.index, command.insertedCount)
}

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

/** Plans a turn of the pages the grid chose. A turn that would come to
    nothing — no pages, or a whole circle — never occupies an undo step. */
export function planRotatePages(
  history: AnnotationHistory,
  pages: number[],
  degrees: number,
) {
  const sorted = [...new Set(pages)].sort((left, right) => left - right)
  const turn = ((degrees % 360) + 360) % 360

  if (sorted.length === 0 || turn === 0) {
    return null
  }

  const command: RotatePagesCommand = {
    degrees: turn,
    kind: "rotatePages",
    pages: sorted,
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

/** The file is unread at plan time: counts settle at the first apply. An
    out-of-range position is the reader's own — refused, never clamped. */
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

/** Writes in the page count the first apply learned — the one fact an insert
    gains only by reading the file — so an undo reads a range known all along. */
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

/** The pages a copied block's undo deletes and its redo restores, valid at the
    LIFO moment the insert sits at the top of history. */
export function insertPagesRange(
  command: InsertPagesCommand | DuplicatePagesCommand,
): number[] {
  return pageRange(command.index, command.sourcePages.length)
}

/** An out-of-range position is the reader's own: refused, never clamped. The
    backend checks the source pages against the document they name. */
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

/** An out-of-range position is the reader's own: refused, never clamped. The
    backend checks the pages against the document they name. */
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
      return command.config
    }
  }

  return null
}

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

export function historyHead(history: AnnotationHistory) {
  return history.past.at(-1)?.id ?? 0
}

export function canUndo(history: AnnotationHistory) {
  return history.past.length > 0
}

export function canRedo(history: AnnotationHistory) {
  return history.future.length > 0
}

export function nextUndoCommand(history: AnnotationHistory) {
  return history.past.at(-1)?.command ?? null
}

export function nextRedoCommand(history: AnnotationHistory) {
  return history.future.at(-1)?.command ?? null
}

/** Identity of the topmost entry, not a count of edits: undoing back to exactly
    what was saved leaves nothing to write, which a growing counter would miss. */
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
