/** What a page-range field holds: every page, the pages a readable selection
    named, or the reason the reader's typing cannot be honoured — sorted and
    free of repeats whatever order they were listed in. */
export type PageSelection =
  | { kind: "all" }
  | { kind: "pages"; pages: number[] }
  | { kind: "invalid" }
  | { kind: "beyond"; page: number }

/** Parses the shorthand a reader types — "1-3, 5, 8-10" — into the one-based
    page numbers it names against a document of `pageCount` pages. Blank input
    means every page; both comma scripts are accepted for the Chinese keyboard. */
export function parsePageRange(input: string, pageCount: number): PageSelection {
  const text = input.trim()
  if (!text) {
    return { kind: "all" }
  }

  const pages: number[] = []
  let beyond: number | undefined
  const note = (page: number) => {
    if (page >= 1 && page <= pageCount) {
      pages.push(page)
    } else {
      beyond = beyond === undefined || page < beyond ? page : beyond
    }
  }
  for (const token of text.split(/[,，]/)) {
    const named = token.trim()
    const single = /^(\d+)$/.exec(named)
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(named)
    if (single) {
      note(Number(single[1]))
    } else if (range && Number(range[1]) <= Number(range[2])) {
      const start = Number(range[1])
      const end = Number(range[2])
      // A range can outrun the document by billions of pages; expanding it
      // before rejecting would hang the tab, so a leaving range names its
      // smallest out-of-bounds page instead. Zero can only be typed, never
      // pasted from the field the odometer owns.
      if (start < 1 || end > pageCount) {
        note(start < 1 || start > pageCount ? start : pageCount + 1)
      } else {
        for (let page = start; page <= end; page += 1) {
          pages.push(page)
        }
      }
    } else {
      return { kind: "invalid" }
    }
  }

  if (beyond !== undefined) {
    return { kind: "beyond", page: beyond }
  }
  return { kind: "pages", pages: [...new Set(pages)].sort((a, b) => a - b) }
}
