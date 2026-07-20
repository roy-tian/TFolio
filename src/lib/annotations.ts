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

export type AnnotationCommand =
  | HighlightCommand
  | RectCommand
  | TextNoteCommand
  | WatermarkCommand

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
  switch (command.kind) {
    case "highlight":
      return command.targets.map((target) => target.pageNumber)
    case "rect":
    case "textNote":
      return [command.pageNumber]
    case "watermark":
      return Array.from({ length: command.pageCount }, (_, index) => index + 1)
  }
}

/** Pages whose selectable page-content text changed, not merely their pixels. */
export function commandTextPages(command: AnnotationCommand): number[] {
  return command.kind === "watermark" ? commandPages(command) : []
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
