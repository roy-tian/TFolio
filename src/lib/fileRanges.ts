import type { AnnotationHistory } from "@/lib/annotations"

/**
 * A contiguous run of pages the multi-file view shows as one card. The backend
 * holds a single merged document; a "file" is only this positional accounting,
 * derived by replaying the command history (the same discipline
 * `watermarkConfig` follows) rather than stored as state that could drift from
 * the document's truth.
 *
 * Positional, not provenance: a page-level edit in the thumbnail grid can move
 * a page out of the file it arrived with, and the card view then shows where
 * the pages actually are — which is the honest thing a position-keyed record
 * can report.
 */
export type FileRange = {
  /** The command id that appended the file, or 0 for the initial document. */
  id: number
  name: string
  /** 1-based position of the range's first slot — the block a card drag and a
      file delete move from. A leading pad (a blank moved to the run's front by a
      page-level edit) can sit here, so this is not always the page the card
      shows: that is `firstReal`. */
  start: number
  /** 1-based position of the range's first real, non-pad page — the page the
      card renders as its face. Equal to `start` unless a pad leads the run. */
  firstReal: number
  /** Real pages in the range, not counting smart-parity pads. */
  pageCount: number
  /** 1-based positions of this file's smart-parity blank pages. Their exact
      positions are kept, not just a count: a page-level move in the thumbnail
      grid can leave a real page sitting after a pad, so a pad is not always the
      run's tail — and mistaking a real page for a pad would delete it. */
  padAt: number[]
}

/** The file this document opened as, before any merges — the initial range's
    name and page count, which the history alone cannot recover. */
export type InitialFile = {
  name: string
  pageCount: number
}

/** One page position in the replayed document: which file owns it, whether it
    is a smart-parity pad rather than a real page, and whether it is a page a
    merge brought in. `merged` is what the save guard reads and `fileId` is what
    the cards read — kept apart because a blank inserted inside a merged file
    inherits that file's id for its card, yet is not another file's content and
    must not keep save disabled (it mirrors the backend's `merged_page_ids`,
    which an inserted blank never joins). */
type Slot = {
  fileId: number
  pad: boolean
  merged: boolean
}

/**
 * Replays the applied history into the current page slots and the file names
 * seen along the way — the shared basis for the file ranges, the document's
 * page count, and where the pad pages sit.
 */
function replaySlots(
  history: AnnotationHistory,
  initialFile: InitialFile,
): { slots: Slot[]; names: Map<number, string> } {
  const names = new Map<number, string>([[0, initialFile.name]])
  let slots: Slot[] = Array.from({ length: initialFile.pageCount }, () => ({
    fileId: 0,
    pad: false,
    merged: false,
  }))

  for (const { command, id } of history.past) {
    switch (command.kind) {
      case "mergeFile": {
        // The range's id is the history entry's — stable across undo/redo, and
        // what the card uses as its React key and name lookup.
        names.set(id, command.name)

        for (let offset = 0; offset < command.pageCount; offset += 1) {
          slots.push({ fileId: id, pad: false, merged: true })
        }

        break
      }
      case "deletePages": {
        // Descending, so each removal leaves the lower positions valid.
        for (const pageNumber of [...command.pages].sort((a, b) => b - a)) {
          slots.splice(pageNumber - 1, 1)
        }

        break
      }
      case "insertBlankPage": {
        // A blank page joins the file to its left, as its trailing page — which
        // is where a smart-parity pad belongs, and a fair home for a plain one.
        // Before everything, it joins the file it pushes right.
        const leftFileId =
          slots[command.index - 2]?.fileId ?? slots[0]?.fileId ?? 0

        // Inherits the left file's id so it rides with that card, but never its
        // merged flag: a blank is this app's own page, not another file's
        // content, so it does not keep the document from saving over its source.
        slots.splice(command.index - 1, 0, {
          fileId: leftFileId,
          pad: Boolean(command.pad),
          merged: false,
        })

        break
      }
      case "reorderPages": {
        // Tags travel with their pages, so a whole-file move keeps the file
        // intact and a page-level move re-homes only what it carried.
        slots = command.order.map((pageNumber) => slots[pageNumber - 1]!)

        break
      }
      default:
        // Annotations and watermarks leave the page structure untouched.
        break
    }
  }

  return { slots, names }
}

/**
 * The current file ranges. A merge appends a file's slots; the ranges fall out
 * as the maximal runs of one file id. A run of only pad pages — a pad stranded
 * from its file by a page-level move — is not a card, though its page still
 * sits in the document (and `padPagePositions` still finds it).
 */
export function fileRanges(
  history: AnnotationHistory,
  initialFile: InitialFile,
): FileRange[] {
  const { slots, names } = replaySlots(history, initialFile)

  return runsToRanges(slots, names)
}

/** The document's current page count, derived from the same replay. */
export function documentPageCount(
  history: AnnotationHistory,
  initialFile: InitialFile,
): number {
  return replaySlots(history, initialFile).slots.length
}

/**
 * Every smart-parity pad page's 1-based position, from the slots rather than the
 * ranges — so a pad stranded from its file (which has no card) is still found,
 * which is what lets turning the feature off remove every pad it added.
 */
export function padPagePositions(
  history: AnnotationHistory,
  initialFile: InitialFile,
): number[] {
  const { slots } = replaySlots(history, initialFile)
  const positions: number[] = []

  slots.forEach((slot, index) => {
    if (slot.pad) {
      positions.push(index + 1)
    }
  })

  return positions
}

/**
 * Whether any page a merge brought in still remains — the frontend mirror of the
 * backend's `merged_page_ids`, and so what the save guard must read. A file card
 * can outlive its merged pages (a blank inserted inside the file inherits its id
 * for the card), so "a range with a non-zero id exists" is not the same question
 * and would keep save disabled after every merged page is gone. This asks the
 * one the backend asks.
 */
export function hasMergedPages(
  history: AnnotationHistory,
  initialFile: InitialFile,
): boolean {
  return replaySlots(history, initialFile).slots.some((slot) => slot.merged)
}

/** Collapses the replayed slots into cards: one per maximal run of a file id,
    dropping a run that holds no real page of its own. */
function runsToRanges(slots: Slot[], names: Map<number, string>): FileRange[] {
  const ranges: FileRange[] = []
  let index = 0

  while (index < slots.length) {
    const fileId = slots[index]!.fileId
    const start = index + 1
    let firstReal = 0
    let pageCount = 0
    const padAt: number[] = []

    while (index < slots.length && slots[index]!.fileId === fileId) {
      if (slots[index]!.pad) {
        padAt.push(index + 1)
      } else {
        if (firstReal === 0) {
          firstReal = index + 1
        }

        pageCount += 1
      }

      index += 1
    }

    // A run of only pad pages is a pad stranded from its file, not a file: its
    // pages remain in the document but it has no card. A card that does form
    // opens on its first real page, never a pad that leads the run.
    if (pageCount > 0) {
      ranges.push({ id: fileId, name: names.get(fileId) ?? "", start, firstReal, pageCount, padAt })
    }
  }

  return ranges
}

/**
 * The page positions a file card owns: every page from its own start up to — but
 * not including — the *next card's* start. Ranges stay sorted by start, so the
 * next card is `ranges[index + 1]`, and the last card runs to the document's
 * end. This is the span a card drag moves and a file delete removes: the file's
 * real pages, its pads, and any page no card covers that falls between it and
 * the next (a smart pad stranded from its file by a page-level move).
 *
 * Owning to the next boundary rather than counting `pageCount + padAt` is what
 * keeps a stranded pad in place — it rides with the card to its left instead of
 * being orphaned — and it is the one definition a reorder and a delete both read,
 * so the two can never disagree about a file's extent.
 */
export function fileBlockPages(
  ranges: FileRange[],
  index: number,
  pageCount: number,
): number[] {
  const start = ranges[index]!.start
  const end = (ranges[index + 1]?.start ?? pageCount + 1) - 1

  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
}

/**
 * The full-document page order after the file cards are arranged into
 * `cardOrder` (1-based positions into `ranges`). Dragging a card is a whole-file
 * move: each card carries its whole block (`fileBlockPages`). The blocks tile the
 * document, so the result is a complete permutation the reorder command accepts.
 * Pages before the first card (a pad dragged to the very front) stay at the front.
 */
export function fileCardOrderToPageOrder(
  ranges: FileRange[],
  cardOrder: number[],
  pageCount: number,
): number[] {
  const firstStart = ranges[0]?.start ?? 1
  const leading = Array.from({ length: firstStart - 1 }, (_, index) => index + 1)
  const blocks = cardOrder.flatMap((cardPosition) =>
    fileBlockPages(ranges, cardPosition - 1, pageCount),
  )

  return [...leading, ...blocks]
}

/** A card's span in the replayed slots: its first real page and its last, so
    the trailing region past it can be told from the file itself. */
type Card = { start: number; lastReal: number }

/** The cards (files with at least one real page) in document order, from the
    slots — which, unlike the ranges, is the full layout including pads stranded
    from their file. */
function cardsFromSlots(slots: Slot[]): Card[] {
  const cards: Card[] = []
  let index = 0

  while (index < slots.length) {
    const fileId = slots[index]!.fileId
    let firstReal = 0
    let lastReal = 0

    while (index < slots.length && slots[index]!.fileId === fileId) {
      if (!slots[index]!.pad) {
        if (firstReal === 0) {
          firstReal = index + 1
        }

        lastReal = index + 1
      }

      index += 1
    }

    // A run of only pad pages is a pad stranded from its file, not a card. The
    // card opens on its first *real* page — a pad that leads the run (a blank
    // moved in front of the file) sits before that, where the guards below find
    // it — not on the run's first slot.
    if (firstReal > 0) {
      cards.push({ start: firstReal, lastReal })
    }
  }

  return cards
}

/**
 * The single next smart-parity edit that moves the document toward "every file
 * after the first opens on an odd page, with no blank that serves no file" —
 * so that, printed double-sided, each file starts on a right-hand leaf.
 *
 * Computed from the page slots, not the cards, so a pad stranded from its file
 * (which shows no card, yet still occupies a page and shifts every file after
 * it) is counted, never planned over. Applied one at a time and re-derived by
 * the caller, the ops converge; `null` means the target already holds.
 */
export function nextParityOp(
  history: AnnotationHistory,
  initialFile: InitialFile,
): { kind: "insert" | "remove"; at: number } | null {
  const { slots } = replaySlots(history, initialFile)
  const isPad = (position: number) => slots[position - 1]?.pad === true
  const cards = cardsFromSlots(slots)

  if (cards.length === 0) {
    return null
  }

  // The first file belongs at page 1; any blank pushed in front of it is surplus.
  for (let position = cards[0]!.start - 1; position >= 1; position -= 1) {
    if (isPad(position)) {
      return { kind: "remove", at: position }
    }
  }

  // Every later file must open on an odd page. A blank right before an even one
  // is what made it even — remove it; otherwise a blank is inserted to bump it.
  // A file that already opens odd needs no blank before it, so a *pair* of
  // blanks there is pure surplus (an even count leaves parity unchanged): drop
  // one, and the file falls to an even page the next pass corrects by dropping
  // the other, landing it back on the same odd leaf two pages earlier. A lone
  // blank before an odd file is load-bearing — it is what made the file odd — so
  // only a pair is touched, which is why this never fights the insert above.
  for (let index = 1; index < cards.length; index += 1) {
    const start = cards[index]!.start

    if (start % 2 === 0) {
      return isPad(start - 1)
        ? { kind: "remove", at: start - 1 }
        : { kind: "insert", at: start }
    }

    if (isPad(start - 1) && isPad(start - 2)) {
      return { kind: "remove", at: start - 1 }
    }
  }

  // Blanks past the last file's real pages serve no parity and are surplus.
  const lastReal = cards[cards.length - 1]!.lastReal

  for (let position = slots.length; position > lastReal; position -= 1) {
    if (isPad(position)) {
      return { kind: "remove", at: position }
    }
  }

  return null
}
