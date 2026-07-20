import type { PagePoint, PagePointsRect } from "@/lib/annotationGeometry"
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
 * The rectangle tool's persisted settings. A colour left `null` is that vector
 * part left off, and `opacity` applies to whichever are present. The effect is
 * separate in a command because an image treatment does not draw those vector
 * parts. Sizes and effect strength are page points.
 */
export type RectStyle = {
  cornerRadius: number
  effect: RectEffect
  fillColor: HexColor | null
  opacity: number
  strokeColor: HexColor | null
  strokeWidth: number
}

export type RectEffectKind = "none" | "mosaic" | "blur"

/** An image treatment applied to the rectangle's source pixels. */
export type RectEffect = {
  kind: RectEffectKind
  /** Mosaic block size or blur sigma, in page points. */
  strength: number
}

/** The vector appearance sent only for an ordinary, effect-free rectangle. */
export type RectAppearance = Omit<RectStyle, "effect">

/**
 * A rectangle is drawn on one page in one drag, so unlike a highlight it never
 * spans pages: one command, one page, one annotation.
 */
export type RectCommand = {
  bounds: PagePointsRect
  effect: RectEffect
  kind: "rect"
  pageNumber: number
  style: RectAppearance
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

export type AnnotationCommand =
  | HighlightCommand
  | RectCommand
  | TextNoteCommand
  | WatermarkCommand
  | ReorderPagesCommand
  | DeletePagesCommand
  | InsertBlankPageCommand

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
      return everyPage(command.pageCount)
    case "reorderPages":
      return everyPage(command.order.length)
    case "deletePages":
    case "insertBlankPage":
      // The larger of the before and after counts, so both the apply and the
      // undo invalidate every page number either shape of the document has.
      return everyPage(command.pageCount)
  }
}

/** Pages whose selectable page-content text changed, not merely their pixels. */
export function commandTextPages(command: AnnotationCommand): number[] {
  switch (command.kind) {
    case "watermark":
    // Structure changes move every page's extractable text somewhere else.
    case "reorderPages":
    case "deletePages":
    case "insertBlankPage":
      return commandPages(command)
    default:
      return []
  }
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
