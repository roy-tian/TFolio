export type Point = { x: number; y: number }

/** Pages a sidebar drag has taken out of its own column: toward another tab's
    column, or onto the tab strip's open space for a new PDF. */
export type CarriedPages = {
  /** Which of `pages` was pressed: the ghost shows it, so it lands on its hole. */
  lead: number
  /** Ascending 1-based page numbers, as the source document stands. */
  pages: number[]
  /** Each page's size before the source's view rotation: a column opening
      holes for the pages turns them as it will show the copies. */
  sizes: { height: number; width: number }[]
  sourceDocumentId: number
}

/** Long enough that crossing the strip opens nothing, short enough to read as
    an answer. */
export const TAB_SPRING_MS = 600

/** What of the tab strip a point is over: a document's tab, the open space
    where a new PDF can start, or anything else on it — a button, a gap, the
    margin above a tab. */
export type StripSpot =
  | { kind: "control" }
  | { kind: "space" }
  | { kind: "tab"; tabId: number }

/** Null off the strip. Hit-tested, so the portalled ghost, which takes no
    pointer, never stands in the way. Only the space the new-PDF offer covers
    is space: a release anywhere else must not make a document unannounced. */
export function stripSpotAt(point: Point): StripSpot | null {
  const element = document.elementFromPoint(point.x, point.y)

  if (!element?.closest("[data-tab-strip]")) {
    return null
  }

  const tabId = Number(
    element.closest<HTMLElement>("[data-document-tab]")?.dataset.documentTab ?? Number.NaN,
  )

  if (Number.isInteger(tabId)) {
    return { kind: "tab", tabId }
  }

  return element.closest("[data-strip-space]") ? { kind: "space" } : { kind: "control" }
}
