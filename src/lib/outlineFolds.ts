import type { PdfOutlineItem } from "@/lib/pdf"

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
