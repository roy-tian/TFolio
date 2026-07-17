import type { PagePointsRect } from "@/lib/annotationGeometry"

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

export type AnnotationCommand = HighlightCommand

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

/** The pages a command writes to, and so the pages an undo has to take back. */
export function commandPages(command: AnnotationCommand): number[] {
  return command.targets.map((target) => target.pageNumber)
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
