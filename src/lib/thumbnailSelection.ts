/**
 * Pure transforms over an immutable value, so every gesture is a testable
 * step and the hook holding this stays a thin wrapper.
 */
export type ThumbnailSelection = {
  /** Selected 1-based page numbers. */
  pages: ReadonlySet<number>
  /** Where a shift range starts: the last plain or toggle click. */
  anchor: number | null
}

export type SelectionModifiers = {
  /** Ctrl on most platforms, ⌘ on macOS — either toggles. */
  toggle: boolean
  range: boolean
}

export const emptySelection: ThumbnailSelection = {
  anchor: null,
  pages: new Set(),
}

function range(from: number, to: number): Set<number> {
  const [low, high] = from <= to ? [from, to] : [to, from]
  const pages = new Set<number>()

  for (let pageNumber = low; pageNumber <= high; pageNumber += 1) {
    pages.add(pageNumber)
  }

  return pages
}

export function selectionAfterClick(
  selection: ThumbnailSelection,
  pageNumber: number,
  modifiers: SelectionModifiers,
): ThumbnailSelection {
  if (modifiers.range && selection.anchor !== null) {
    // The range replaces the selection but keeps the anchor, so successive
    // shift-clicks re-span from the same starting page — as file managers do.
    return {
      anchor: selection.anchor,
      pages: range(selection.anchor, pageNumber),
    }
  }

  if (modifiers.toggle) {
    const pages = new Set(selection.pages)

    if (pages.has(pageNumber)) {
      pages.delete(pageNumber)
    } else {
      pages.add(pageNumber)
    }

    return { anchor: pageNumber, pages }
  }

  return { anchor: pageNumber, pages: new Set([pageNumber]) }
}

/** A click on a run of pages as one, a file's name over its pages: plain
    chooses them alone, a toggle adds them or, all chosen, lets them go, and
    a range reaches from the anchor to the run's far end. */
export function selectionAfterGroupClick(
  selection: ThumbnailSelection,
  pages: readonly number[],
  modifiers: SelectionModifiers,
): ThumbnailSelection {
  if (pages.length === 0) {
    return selection
  }

  // Folded, not spread: a long file can pass the engine's argument limit.
  const first = pages.reduce((low, pageNumber) => Math.min(low, pageNumber))
  const last = pages.reduce((high, pageNumber) => Math.max(high, pageNumber))

  if (modifiers.range && selection.anchor !== null) {
    return {
      anchor: selection.anchor,
      pages: range(Math.min(selection.anchor, first), Math.max(selection.anchor, last)),
    }
  }

  if (modifiers.toggle) {
    const next = new Set(selection.pages)
    const all = pages.every((pageNumber) => next.has(pageNumber))

    for (const pageNumber of pages) {
      if (all) {
        next.delete(pageNumber)
      } else {
        next.add(pageNumber)
      }
    }

    return { anchor: first, pages: next }
  }

  return { anchor: first, pages: new Set(pages) }
}

/** The selection with `pages` let go: folded away under their file's name,
    they would be deleted or cut unseen. An anchor among them goes too, or
    the next range would start from a page that does not show. */
export function selectionWithout(
  selection: ThumbnailSelection,
  pages: readonly number[],
): ThumbnailSelection {
  const gone = new Set(pages)
  const kept = new Set<number>()

  for (const pageNumber of selection.pages) {
    if (!gone.has(pageNumber)) {
      kept.add(pageNumber)
    }
  }

  const anchor = selection.anchor !== null && gone.has(selection.anchor) ? null : selection.anchor

  return kept.size === selection.pages.size && anchor === selection.anchor
    ? selection
    : { anchor, pages: kept }
}

/** A click over items listed in `order`, as `selectionAfterClick` takes one;
    an anchor no longer listed makes a range click a plain one. */
export function choiceAfterClick<T>(
  order: readonly T[],
  chosen: ReadonlySet<T>,
  anchor: T | null,
  item: T,
  { range, toggle }: SelectionModifiers,
): { anchor: T; chosen: Set<T> } {
  const from = anchor === null ? -1 : order.indexOf(anchor)

  if (range && from !== -1) {
    const to = order.indexOf(item)

    return {
      anchor: anchor!,
      chosen: new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)),
    }
  }

  if (toggle) {
    const next = new Set(chosen)

    if (!next.delete(item)) {
      next.add(item)
    }

    return { anchor: item, chosen: next }
  }

  return { anchor: item, chosen: new Set([item]) }
}

/** The anchor goes to the first page, so a shift-click after select-all
    narrows from there, not from the last single click. */
export function selectionOfAllPages(numPages: number): ThumbnailSelection {
  return numPages < 1 ? emptySelection : { anchor: 1, pages: range(1, numPages) }
}
