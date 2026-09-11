/**
 * The thumbnail grid's selection: which pages are chosen, and where a shift
 * range anchors. Pure transforms over an immutable value, so every gesture is
 * a unit-testable step and the hook holding this stays a thin wrapper.
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

/** One click, whatever its modifiers, to the selection it leaves behind. */
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

/**
 * Every page at once, as the grid's select-all leaves it. The anchor goes to
 * the first page, so a shift-click after it narrows the selection from there
 * rather than from wherever the last single click happened to be.
 */
export function selectionOfAllPages(numPages: number): ThumbnailSelection {
  return numPages < 1 ? emptySelection : { anchor: 1, pages: range(1, numPages) }
}

/**
 * The selection still valid after the document's pages changed shape. Page
 * numbers may now name different pages entirely, so nothing survives — the
 * one honest answer a selection keyed by position can give.
 */
export function selectionAfterStructureChange(): ThumbnailSelection {
  return emptySelection
}
