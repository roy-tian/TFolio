import type { PagePoint, PagePointsRect } from "@/lib/annotationGeometry"
import type { DocumentState } from "@/lib/documentState"
import {
  samePageNumbersConfig,
  type PageNumbersConfig,
} from "@/lib/pageNumbers"
import type { FileOptions } from "@/lib/pdf"
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
  /** Each position's file after the move and before it, in a document of
      several files: a page dropped among another file's joins it. */
  sections?: { after: number[]; before: number[] }
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
  /** The file it joins, in a document of several. */
  section?: number
  /** Pages in the document after the insertion. */
  pageCount: number
  /** The history entry's own id; the undo's delete stashes under it, and a
      redo's delete replaces that stash rather than colliding with it. */
  stashId: number
}

/** The sidebar's copy-and-paste. A redo restores the undo's stash rather than
    copying again. */
export type DuplicatePagesCommand = {
  kind: "duplicatePages"
  /** 1-based position the first copy takes, from 1 to page count + 1. */
  index: number
  /** The file the copies join, in a document of several. */
  section?: number
  /** Pages in the document after the copies landed. */
  pageCount: number
  /** Ascending 1-based page numbers, as the document stood before the paste. */
  sourcePages: number[]
  /** The history entry's own id: the undo deletes the copied range under it,
      and the redo restores exactly that stash. */
  stashId: number
}

/** The sidebar's drag onto another tab. A redo restores the undo's stash, so
    the source may be gone by then. */
export type InsertPagesCommand = {
  kind: "insertPages"
  /** 1-based position the first copy takes, from 1 to page count + 1. */
  index: number
  /** The file the copies join, in a document of several. */
  section?: number
  /** Pages in the document after the copies landed. */
  pageCount: number
  sourceDocumentId: number
  /** Ascending 1-based page numbers, as the source document stood. */
  sourcePages: number[]
  /** The history entry's own id: the undo deletes the copied range under it,
      and the redo restores exactly that stash. */
  stashId: number
}

/** Files read from disk, added before `index` as files of their own. Like a
    paste, the first apply reads them and a redo restores the undo's stash. */
export type InsertFilesCommand = {
  kind: "insertFiles"
  index: number
  /** Pages in the document after the files landed. */
  pageCount: number
  /** How many pages the files brought, all of them together. */
  count: number
  /** Their names, for the history's words. */
  titles: string[]
  stashId: number
}

/** The name a file of the document goes by, and its bookmark in a Save As. */
export type RenameSectionCommand = {
  kind: "renameSection"
  previous: string
  sectionId: number
  title: string
}

/** How the document's files are laid out and saved; no page changes. */
export type FileOptionsCommand = {
  kind: "fileOptions"
  next: FileOptions
  previous: FileOptions
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
  | DuplicatePagesCommand
  | InsertPagesCommand
  | InsertFilesCommand
  | RenameSectionCommand
  | FileOptionsCommand
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
  /** What the file on disk holds, taken at the save; null while it is the
      file as opened (`savedId` 0). */
  saved: DocumentState | null
  /** The entry the document on disk ends at; 0 for a file with none of these. */
  savedId: number
}

export const emptyHistory: AnnotationHistory = {
  future: [],
  nextId: 1,
  past: [],
  saved: null,
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

/** An array maps each position after an edit to the page number it held before,
    null for a page the edit brought in; `"inPlace"` moved nothing, so
    everything held by page number stays true. */
export type PageMovement = (number | null)[] | "inPlace"

/** `pages` taken out of `pageCount`: the rest close up in order. */
function departures(pages: number[], pageCount: number): number[] {
  const leaving = new Set(pages)

  return everyPage(pageCount).filter((page) => !leaving.has(page))
}

/** `pages` arrived where they stand among `pageCount`; the rest keep their order. */
function arrivals(pages: number[], pageCount: number): (number | null)[] {
  const arrived = new Set(pages)
  let previous = 0

  return everyPage(pageCount).map((page) => (arrived.has(page) ? null : (previous += 1)))
}

/** How a structure edit moved the pages. One that takes pages out puts them
    in its stash, and one that brings pages in may bring that stash's back. */
export type PageChange = { movement: PageMovement; stashId?: number }

/** What a structure command, or its undo, does to the pages — valid at the
    LIFO moment it runs. Undefined for a command that leaves the page list alone. */
export function commandPageChange(
  command: AnnotationCommand,
  undoing: boolean,
): PageChange | undefined {
  switch (command.kind) {
    case "reorderPages":
      return { movement: undoing ? command.inverse : command.order }
    case "rotatePages":
      return { movement: "inPlace" }
    case "deletePages":
      return {
        // The undo puts each page back where it stood before the delete.
        movement: undoing
          ? arrivals(command.pages, command.pageCount)
          : departures(command.pages, command.pageCount),
        stashId: command.stashId,
      }
    case "insertBlankPage":
      return {
        // A redo's blank is the one its undo took out: LIFO has taken back
        // anything drawn on it, and the gap's neighbours size it alike.
        movement: undoing
          ? departures([command.index], command.pageCount)
          : arrivals([command.index], command.pageCount),
        stashId: command.stashId,
      }
    case "duplicatePages":
    case "insertPages":
    case "insertFiles":
      return {
        movement: undoing
          ? departures(insertPagesRange(command), command.pageCount)
          : arrivals(insertPagesRange(command), command.pageCount),
        stashId: command.stashId,
      }
    // A name or a choice changes; every page stays where it is.
    case "renameSection":
    case "fileOptions":
      return { movement: "inPlace" }
    default:
      return undefined
  }
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
      // From the gap on, and against the count after the insertion — again
      // the larger of the two shapes.
      return pagesFrom(command.index, command.pageCount)
    case "duplicatePages":
    case "insertPages":
    case "insertFiles":
      // Only from the gap on — an append at the very end invalidates nothing.
      // `pageCount` spans before and after, covering the apply and the undo alike.
      return pagesFrom(command.index, command.pageCount)
    case "renameSection":
    case "fileOptions":
      return []
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
    case "duplicatePages":
    case "insertPages":
    case "insertFiles":
      return true
    case "renameSection":
    case "fileOptions":
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
    case "duplicatePages":
    case "insertPages":
    case "insertFiles":
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
      saved: history.saved,
      savedId: history.savedId,
    } satisfies AnnotationHistory,
  }
}

/** Records where the erased annotations actually were, which only the apply
    learns. */
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
export function planReorderPages(
  history: AnnotationHistory,
  order: number[],
  sections?: ReorderPagesCommand["sections"],
) {
  // A page moved to the edge of the next file stands where it was, yet joins it.
  const regrouped =
    sections !== undefined &&
    sections.after.some((section, index) => section !== sections.before[index])

  if (isIdentityOrder(order) && !regrouped) {
    return null
  }

  const command: ReorderPagesCommand = {
    inverse: inversePermutation(order),
    kind: "reorderPages",
    order,
    ...(sections === undefined ? {} : { sections }),
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
  section?: number,
) {
  if (index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertBlankPageCommand = {
    index,
    kind: "insertBlankPage",
    pageCount: pageCount + 1,
    ...(section === undefined ? {} : { section }),
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** The pages a copied block's undo deletes and its redo restores, valid at the
    LIFO moment the insert sits at the top of history. */
export function insertPagesRange(
  command: DuplicatePagesCommand | InsertPagesCommand | InsertFilesCommand,
): number[] {
  return pageRange(
    command.index,
    command.kind === "insertFiles" ? command.count : command.sourcePages.length,
  )
}

/** An out-of-range position is the reader's own: refused, never clamped. The
    backend checks the pages against the document they name. */
export function planDuplicatePages(
  history: AnnotationHistory,
  sourcePages: number[],
  index: number,
  pageCount: number,
  section?: number,
) {
  const pages = [...new Set(sourcePages)].sort((left, right) => left - right)

  if (pages.length === 0 || index < 1 || index > pageCount + 1) {
    return null
  }

  const command: DuplicatePagesCommand = {
    index,
    kind: "duplicatePages",
    pageCount: pageCount + pages.length,
    ...(section === undefined ? {} : { section }),
    sourcePages: pages,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** As `planDuplicatePages`, the pages named as the source document stands. */
export function planInsertPages(
  history: AnnotationHistory,
  sourceDocumentId: number,
  sourcePages: number[],
  index: number,
  pageCount: number,
  section?: number,
) {
  const pages = [...new Set(sourcePages)].sort((left, right) => left - right)

  if (pages.length === 0 || index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertPagesCommand = {
    index,
    kind: "insertPages",
    pageCount: pageCount + pages.length,
    ...(section === undefined ? {} : { section }),
    sourceDocumentId,
    sourcePages: pages,
    stashId: history.nextId,
  }

  return { command, history: commit(history, command) }
}

/** Files already read for their pages, `count` of them in all. */
export function planInsertFiles(
  history: AnnotationHistory,
  titles: string[],
  count: number,
  index: number,
  pageCount: number,
) {
  if (titles.length === 0 || count < 1 || index < 1 || index > pageCount + 1) {
    return null
  }

  const command: InsertFilesCommand = {
    count,
    index,
    kind: "insertFiles",
    pageCount: pageCount + count,
    stashId: history.nextId,
    titles,
  }

  return { command, history: commit(history, command) }
}

/** A choice already made takes no undo step. */
export function planFileOptions(
  history: AnnotationHistory,
  next: FileOptions,
  previous: FileOptions,
) {
  if (
    next.smartPadding === previous.smartPadding &&
    next.perFileBookmarks === previous.perFileBookmarks
  ) {
    return null
  }

  const command: FileOptionsCommand = { kind: "fileOptions", next, previous }

  return { command, history: commit(history, command) }
}

/** A name the file already has takes no undo step. */
export function planRenameSection(
  history: AnnotationHistory,
  sectionId: number,
  title: string,
  previous: string,
) {
  const trimmed = title.trim()

  if (trimmed === "" || trimmed === previous) {
    return null
  }

  const command: RenameSectionCommand = {
    kind: "renameSection",
    previous,
    sectionId,
    title: trimmed,
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

/** Anything undone is dropped: the reader has taken a new branch. */
export function commit(
  history: AnnotationHistory,
  command: AnnotationCommand,
): AnnotationHistory {
  return {
    future: [],
    nextId: history.nextId + 1,
    past: [...history.past, { command, id: history.nextId }],
    saved: history.saved,
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
      saved: history.saved,
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
      saved: history.saved,
      savedId: history.savedId,
    },
  }
}

/** The stashes a step leaves nothing to restore: an undone insert holds its
    pages in one until its redo, and a new branch drops that redo for good.
    An undone delete holds none — its undo already took its stash back. */
export function droppedStashIds(
  before: AnnotationHistory,
  after: AnnotationHistory,
): number[] {
  if (before.future.length === 0) {
    return []
  }

  const kept = new Set(
    [...after.past, ...after.future].map((entry) => entry.id),
  )

  return before.future.flatMap((entry) => {
    if (kept.has(entry.id)) {
      return []
    }

    switch (entry.command.kind) {
      case "insertBlankPage":
      case "duplicatePages":
      case "insertPages":
      case "insertFiles":
        return [entry.command.stashId]
      default:
        return []
    }
  })
}
