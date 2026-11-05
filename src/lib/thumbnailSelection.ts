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
