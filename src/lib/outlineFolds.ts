import type { FileRun } from "@/lib/pageSections"
import type { PdfOutlineItem, PdfSection } from "@/lib/pdf"

/** What the sidebar's outline holds folded, by key: a document's bookmarks
    by their place under their parent's, and a file of several by its id. */
export type OutlineFolds = ReadonlySet<string>

export const NO_FOLDS: OutlineFolds = new Set()

export function bookmarkFoldKey(parentKey: string, index: number) {
  return `${parentKey}-${index}`
}

export function fileFoldKey(sectionId: number) {
  return `file-${sectionId}`
}

export function fileRunKey(run: Pick<FileRun, "ordinal" | "section">) {
  return `${run.section}:${run.ordinal}`
}

export const DOCUMENT_OUTLINE_KEY = "root"

/** The parent key of a file's bookmarks, wherever they show: kept apart from
    the document's, so folds made in one outline never land in another's. */
export function sectionOutlineKey(sectionId: number) {
  return `section-${sectionId}`
}

export function nestsBookmarks(items: readonly PdfOutlineItem[]) {
  return items.some((item) => item.items.length > 0)
}

/** The bookmarks with others under them, at every depth: those an arrow folds. */
export function foldableBookmarks(items: readonly PdfOutlineItem[], parentKey: string): string[] {
  return items.flatMap((item, index) => {
    if (item.items.length === 0) {
      return []
    }

    const key = bookmarkFoldKey(parentKey, index)

    return [key, ...foldableBookmarks(item.items, key)]
  })
}

export function toggledFold(folds: OutlineFolds, key: string): OutlineFolds {
  const next = new Set(folds)

  if (!next.delete(key)) {
    next.add(key)
  }

  return next
}

/** Fold key of the parent holding the bookmark at `path` under `rootKey`. */
export function bookmarkParentKey(rootKey: string, path: readonly number[]) {
  let key = rootKey

  for (let index = 0; index < path.length - 1; index += 1) {
    key = bookmarkFoldKey(key, path[index]!)
  }

  return key
}

/** Unfolds every ancestor bookmark (and enclosing file, if any) along `path`
    so an inserted or drafted bookmark row is immediately visible. */
export function unfoldBookmarkAncestors(
  folds: OutlineFolds,
  rootKey: string,
  path: readonly number[],
  sectionId?: number,
): OutlineFolds {
  const toRemove: string[] = []

  if (sectionId !== undefined) {
    const fileKey = fileFoldKey(sectionId)

    if (folds.has(fileKey)) {
      toRemove.push(fileKey)
    }
  }

  let key = rootKey

  for (let index = 0; index < path.length - 1; index += 1) {
    key = bookmarkFoldKey(key, path[index]!)

    if (folds.has(key)) {
      toRemove.push(key)
    }
  }

  if (toRemove.length === 0) {
    return folds
  }

  const next = new Set(folds)

  for (const entry of toRemove) {
    next.delete(entry)
  }

  return next
}

/** Shifts sibling fold keys at or after `index` under `parentKey` up by one. */
export function foldsAfterBookmarkInsert(
  folds: OutlineFolds,
  parentKey: string,
  index: number,
): OutlineFolds {
  const prefix = `${parentKey}-`
  let changed = false
  const next = new Set<string>()

  for (const key of folds) {
    if (!key.startsWith(prefix)) {
      next.add(key)
      continue
    }

    const tail = key.slice(prefix.length)
    const dash = tail.indexOf("-")
    const segment = dash < 0 ? tail : tail.slice(0, dash)
    const rest = dash < 0 ? "" : tail.slice(dash)

    if (!/^\d+$/.test(segment)) {
      next.add(key)
      continue
    }

    const siblingIndex = Number(segment)

    if (siblingIndex >= index) {
      changed = true
      next.add(`${prefix}${siblingIndex + 1}${rest}`)
    } else {
      next.add(key)
    }
  }

  return changed ? next : folds
}

/**
 * Where a new bookmark for `pageNumber` belongs in `items`: immediately after
 * the active bookmark for `pageNumber` in reading order (as its first child
 * when it has children — whose pages come after — otherwise as its next
 * sibling). Before every valid bookmark it lands at `[0]`; when no bookmark
 * carries a page number it appends at `[items.length]`.
 */
export function bookmarkInsertPath(
  items: readonly PdfOutlineItem[],
  pageNumber: number,
): number[] {
  let bestPage = -1
  let bestPath: number[] | null = null
  let bestItem: PdfOutlineItem | null = null
  let crossedHigher = false
  let hasAnyPage = false

  const walk = (list: readonly PdfOutlineItem[], prefix: number[]) => {
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index]!
      const path = [...prefix, index]

      if (item.pageNumber !== null) {
        hasAnyPage = true

        if (item.pageNumber > pageNumber) {
          crossedHigher = true
        } else if (
          item.pageNumber > bestPage ||
          (item.pageNumber === bestPage && !crossedHigher)
        ) {
          bestPage = item.pageNumber
          bestPath = path
          bestItem = item
          crossedHigher = false
        }
      }

      if (item.items.length > 0) {
        walk(item.items, path)
      }
    }
  }

  walk(items, [])

  if (bestPath === null || bestItem === null) {
    return [hasAnyPage ? 0 : items.length]
  }

  if ((bestItem as PdfOutlineItem).items.length > 0) {
    return [...(bestPath as number[]), 0]
  }

  const leafPath = bestPath as number[]

  return [...leafPath.slice(0, -1), leafPath.at(-1)! + 1]
}

/** Drops fold keys for the deleted bookmark and its descendants, and shifts
    later sibling keys under `parentKey` down by one. */
export function foldsAfterBookmarkDelete(
  folds: OutlineFolds,
  parentKey: string,
  index: number,
): OutlineFolds {
  const prefix = `${parentKey}-`
  const next = new Set<string>()

  for (const key of folds) {
    if (!key.startsWith(prefix)) {
      next.add(key)
      continue
    }

    const tail = key.slice(prefix.length)
    const dash = tail.indexOf("-")
    const segment = dash < 0 ? tail : tail.slice(0, dash)
    const rest = dash < 0 ? "" : tail.slice(dash)

    if (!/^\d+$/.test(segment)) {
      next.add(key)
      continue
    }

    const siblingIndex = Number(segment)

    if (siblingIndex === index) {
      continue
    }

    next.add(siblingIndex > index ? `${prefix}${siblingIndex - 1}${rest}` : key)
  }

  return next
}

/**
 * Folding and unfolding the whole outline: `top` are the folds its first
 * level shows, `all` every fold there is beneath them too. Folding folds them
 * all, so a file or bookmark opened again shows its own folded. Only an open
 * fold of the first level shows anything to fold: every one deeper that shows
 * stands under one.
 */
export function foldAllOf(folds: OutlineFolds, top: readonly string[], all: readonly string[]) {
  return {
    canFold: top.some((key) => !folds.has(key)),
    canUnfold: all.some((key) => folds.has(key)),
    fold: (folded: boolean): OutlineFolds => {
      const next = new Set(folds)

      for (const key of all) {
        if (folded) {
          next.add(key)
        } else {
          next.delete(key)
        }
      }

      return next
    },
  }
}

/**
 * The visible bookmark key for `pageNumber`: the deepest/latest bookmark in
 * pre-order whose page is `<= pageNumber` with the highest page number (so an
 * out-of-order back-link later in the tree cannot hijack an earlier section).
 * Where an ancestor of that match is folded away, that collapsed ancestor
 * stands in for it instead of unfolding the reader's outline.
 */
export function activeBookmarkKey(
  items: readonly PdfOutlineItem[],
  parentKey: string,
  pageNumber: number,
  folds: OutlineFolds,
): string | null {
  let bestPage = -1
  let bestKey: string | null = null
  let crossedHigher = false

  const walk = (
    list: readonly PdfOutlineItem[],
    prefix: string,
    foldedAncestor: string | null,
  ) => {
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index]!
      // Once inside a folded ancestor, every descendant stands behind that
      // ancestor's key, avoiding key formatting and fold lookups below it.
      const key = foldedAncestor ?? bookmarkFoldKey(prefix, index)

      if (item.pageNumber !== null) {
        if (item.pageNumber > pageNumber) {
          crossedHigher = true
        } else if (
          item.pageNumber > bestPage ||
          (item.pageNumber === bestPage && !crossedHigher)
        ) {
          bestPage = item.pageNumber
          bestKey = key
          crossedHigher = false
        }
      }

      if (item.items.length > 0) {
        const nextFolded = foldedAncestor ?? (folds.has(key) ? key : null)
        walk(item.items, key, nextFolded)
      }
    }
  }

  walk(items, parentKey, null)

  return bestKey
}

export type FileOutlineTarget =
  | { kind: "bookmark"; key: string }
  | { kind: "file"; key: string }

/** Which visible row of the multi-file outline holds `pageNumber`: an open
    bookmark under its file when one covers it, otherwise the file's own row. */
export function activeFileOutlineTarget(
  runs: readonly FileRun[],
  sections: ReadonlyMap<number, PdfSection>,
  pageNumber: number,
  folds: OutlineFolds,
): FileOutlineTarget | null {
  const run = runs.find(
    (candidate) => pageNumber >= candidate.first && pageNumber < candidate.first + candidate.count,
  )

  if (!run) {
    return null
  }

  const section = sections.get(run.section)

  if (
    run.leads &&
    section &&
    section.outline.length > 0 &&
    !folds.has(fileFoldKey(section.id))
  ) {
    const bookmark = activeBookmarkKey(
      section.outline,
      sectionOutlineKey(section.id),
      pageNumber,
      folds,
    )

    if (bookmark !== null) {
      return { kind: "bookmark", key: bookmark }
    }
  }

  return { kind: "file", key: fileRunKey(run) }
}
