import {
  commandPageChange,
  historyHead,
  insertPagesRange,
  type AnnotationCommand,
  type AnnotationEntry,
  type AnnotationHistory,
} from "@/lib/annotations"
import { samePageNumbersConfig, type PageNumbersConfig } from "@/lib/pageNumbers"
import type { FileOptions } from "@/lib/pdf"
import { sameWatermarkConfig, type WatermarkConfig } from "@/lib/watermark"

/** A page by identity, never by look: an opened page is its number at open; a
    page an entry brought in is that entry's, since a redo restores the very
    page its undo stashed. Another blank page is another page. */
type PageToken = number | string

/** A value as it first stood and as it stands; equal again, it is untouched. */
type Changed<T> = { from: T; to: T }

/** A layer the engine drew to the pages' order and turns as they stood, and
    never redraws when they move: the same config over another layout is
    other content. */
type Stamped<T> = { config: T; over: string }

/** What a save would write, as this session's applied history says. Plain
    data: it travels with a moved tab's history. */
export type DocumentState = {
  /** A step this comparison does not model is in effect, so no state equals it. */
  opaque: boolean
  /** Null until a step moves a page: the pages as opened. */
  pages: { opened: number; tokens: PageToken[] } | null
  /** Clockwise turn per page token, absent where none. */
  turns: Record<string, number>
  /** The mark-making entries in effect; an erase has already taken its out. */
  marks: number[]
  watermark: Stamped<WatermarkConfig> | null
  pageNumbers: Stamped<PageNumbersConfig> | null
  fileOptions: Changed<FileOptions> | null
  titles: Record<string, Changed<string>>
}

type MovingCommand = Extract<
  AnnotationCommand,
  { kind: "reorderPages" | "deletePages" | "insertBlankPage" | "duplicatePages" | "insertPages" }
>

/** Pages before the first step that moves any; every later step's count
    follows from it. */
function openedPageCount(command: MovingCommand): number {
  switch (command.kind) {
    case "reorderPages":
      return command.order.length
    case "deletePages":
      return command.pageCount
    case "insertBlankPage":
      return command.pageCount - 1
    case "duplicatePages":
    case "insertPages":
      return command.pageCount - insertPagesRange(command).length
  }
}

function move(state: DocumentState, entry: AnnotationEntry, command: MovingCommand) {
  const movement = commandPageChange(command, false)?.movement

  if (movement === undefined || movement === "inPlace") {
    return
  }

  const opened = state.pages?.opened ?? openedPageCount(command)
  const before = state.pages?.tokens
  let brought = 0
  const tokens = movement.map((from): PageToken | undefined => {
    if (from === null) {
      return `${entry.id}.${brought++}`
    }

    return before ? before[from - 1] : from <= opened ? from : undefined
  })

  if (tokens.some((token) => token === undefined)) {
    state.opaque = true
    return
  }

  state.pages = { opened, tokens: tokens as PageToken[] }
}

function turn(state: DocumentState, pages: number[], degrees: number) {
  for (const page of pages) {
    const token = state.pages ? state.pages.tokens[page - 1] : page

    if (token === undefined) {
      state.opaque = true
      return
    }

    const turned = ((state.turns[token] ?? 0) + degrees) % 360

    if (turned === 0) {
      delete state.turns[token]
    } else {
      state.turns[token] = turned
    }
  }
}

/** The pages' order and turns as a key; an order back as opened reads as none. */
function layoutKey(state: DocumentState, ...also: unknown[]) {
  const tokens = state.pages?.tokens ?? null
  const asOpened =
    tokens === null ||
    (tokens.length === state.pages?.opened &&
      tokens.every((token, index) => token === index + 1))
  const turns = Object.entries(state.turns).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )

  return JSON.stringify([asOpened ? null : tokens, turns, ...also])
}

function apply(state: DocumentState, entry: AnnotationEntry) {
  const { command } = entry

  switch (command.kind) {
    case "highlight":
    case "rect":
    case "textNote":
      state.marks.push(entry.id)
      return
    case "eraseAnnotation":
      return
    case "watermark":
      state.watermark = command.config && { config: command.config, over: layoutKey(state) }
      return
    // Their ink is sampled over the watermark beneath them.
    case "pageNumbers":
      state.pageNumbers = command.config && {
        config: command.config,
        over: layoutKey(state, state.watermark),
      }
      return
    case "fileOptions":
      state.fileOptions = { from: state.fileOptions?.from ?? command.previous, to: command.next }
      return
    case "renameSection": {
      const key = String(command.sectionId)

      state.titles[key] = { from: state.titles[key]?.from ?? command.previous, to: command.title }
      return
    }
    case "rotatePages":
      turn(state, command.pages, command.degrees)
      return
    case "reorderPages": {
      const { sections } = command

      // A page moved into another file regroups runs only the engine knows.
      if (sections?.after.some((section, index) => section !== sections.before[index])) {
        state.opaque = true
        return
      }

      move(state, entry, command)
      return
    }
    case "deletePages":
    case "insertBlankPage":
    case "duplicatePages":
    case "insertPages":
      move(state, entry, command)
      return
    // Its runs, padding and bookmarks are the engine's to say; a document
    // carrying them is never judged the same as one without.
    case "insertFiles":
      state.opaque = true
      return
    default:
      // A kind added without a decision here fails to compile, and one that
      // arrives anyway counts as a change.
      command satisfies never
      state.opaque = true
  }
}

/** The state `past` leaves the document in, from the state it opened in. */
export function documentState(past: AnnotationEntry[]): DocumentState {
  const state: DocumentState = {
    fileOptions: null,
    marks: [],
    opaque: false,
    pageNumbers: null,
    pages: null,
    titles: {},
    turns: {},
    watermark: null,
  }

  for (const entry of past) {
    apply(state, entry)

    if (state.opaque) {
      break
    }
  }

  state.marks.sort((left, right) => left - right)

  return state
}

function sameList<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function changedTo<T>(
  changed: Changed<T> | undefined | null,
  same: (left: T, right: T) => boolean,
) {
  return changed && !same(changed.from, changed.to) ? changed : null
}

function sameFileOptions(left: FileOptions, right: FileOptions) {
  return (
    left.smartPadding === right.smartPadding && left.perFileBookmarks === right.perFileBookmarks
  )
}

/** Whether a save of one would write what the other already holds. */
export function sameDocumentState(left: DocumentState, right: DocumentState): boolean {
  if (left.opaque || right.opaque) {
    return false
  }

  const opened = left.pages?.opened ?? right.pages?.opened
  const identity = () => Array.from({ length: opened ?? 0 }, (_, index) => index + 1)
  const leftTokens = left.pages?.tokens ?? (right.pages ? identity() : null)
  const rightTokens = right.pages?.tokens ?? (left.pages ? identity() : null)

  if (leftTokens && rightTokens && !sameList(leftTokens, rightTokens)) {
    return false
  }

  // A turn on a page no longer in the document is nothing a save writes.
  const turned =
    leftTokens ?? [...new Set([...Object.keys(left.turns), ...Object.keys(right.turns)])]

  if (turned.some((token) => (left.turns[token] ?? 0) !== (right.turns[token] ?? 0))) {
    return false
  }

  if (!sameList(left.marks, right.marks)) {
    return false
  }

  if (
    left.watermark?.over !== right.watermark?.over ||
    left.pageNumbers?.over !== right.pageNumbers?.over ||
    !sameWatermarkConfig(left.watermark?.config ?? null, right.watermark?.config ?? null) ||
    !samePageNumbersConfig(left.pageNumbers?.config ?? null, right.pageNumbers?.config ?? null)
  ) {
    return false
  }

  const leftOptions = changedTo(left.fileOptions, sameFileOptions)
  const rightOptions = changedTo(right.fileOptions, sameFileOptions)

  if (
    leftOptions === null || rightOptions === null
      ? leftOptions !== rightOptions
      : !sameFileOptions(leftOptions.to, rightOptions.to)
  ) {
    return false
  }

  const sameTitle = (from: string, to: string) => from === to

  return [...new Set([...Object.keys(left.titles), ...Object.keys(right.titles)])].every(
    (section) =>
      changedTo(left.titles[section], sameTitle)?.to ===
      changedTo(right.titles[section], sameTitle)?.to,
  )
}

const dirtiness = new WeakMap<AnnotationHistory, boolean>()

/** Whether the document holds anything its file does not. Undoing back to the
    save is clean by the head alone; otherwise the states are compared, so a
    full turn or an inserted page deleted again leaves nothing to write. */
export function isDirty(history: AnnotationHistory) {
  if (historyHead(history) === history.savedId) {
    return false
  }

  const known = dirtiness.get(history)

  if (known !== undefined) {
    return known
  }

  // Without the saved state, only the head can say, and it says dirty.
  const saved = history.savedId === 0 ? documentState([]) : history.saved
  const dirty = !saved || !sameDocumentState(documentState(history.past), saved)

  dirtiness.set(history, dirty)

  return dirty
}

export function markSaved(history: AnnotationHistory): AnnotationHistory {
  return { ...history, saved: documentState(history.past), savedId: historyHead(history) }
}
