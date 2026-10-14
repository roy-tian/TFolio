import { rangeWithin } from "@/lib/textSelection"
import { textPage } from "@/lib/textSelectionPage"

/** PDFium's text for a page: at once when it has been read, else a promise
    that settles with "" rather than rejecting. */
export type PageTextReader = (pageNumber: number) => string | Promise<string>

const readers = new WeakMap<Element, PageTextReader>()

/** A viewer's session lends it the reader for pages it shows without spans. */
export function registerPageTextReader(viewer: Element, reader: PageTextReader) {
  readers.set(viewer, reader)

  return () => {
    if (readers.get(viewer) === reader) {
      readers.delete(viewer)
    }
  }
}

export type SelectedPages = {
  first: number
  /** The wrapper of the page the selection starts on. */
  firstPage: HTMLElement
  last: number
  lastPage: HTMLElement
  range: Range
  viewer: Element
}

function pageOf(node: Node) {
  const element = node instanceof Element ? node : node.parentElement

  return element?.closest<HTMLElement>("[data-page-number]") ?? null
}

/** The pages a selection of page text runs over; null for any other selection. */
export function selectedPages(selection: Selection | null): SelectedPages | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null
  }

  const anchor = selection.anchorNode
  const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement

  if (!anchorElement?.closest(".pdf-text-layer")) {
    return null
  }

  const range = selection.getRangeAt(0)
  const start = pageOf(range.startContainer)
  const end = pageOf(range.endContainer)
  const viewer = start?.closest("[data-pdf-scroll-root]")

  if (!start || !end || !viewer || !viewer.contains(end)) {
    return null
  }

  return {
    first: Number(start.dataset.pageNumber),
    firstPage: start,
    last: Number(end.dataset.pageNumber),
    lastPage: end,
    range,
    viewer,
  }
}

/** The pages strictly between the selection's ends, in page order. */
export function pagesBetween({ first, last, viewer }: SelectedPages) {
  const pages: [number, HTMLElement][] = []

  // One pass over the viewer, not a lookup per page: a long selection spans
  // hundreds of wrappers, and a fragmented page holds a thousand spans.
  for (const page of viewer.querySelectorAll<HTMLElement>("[data-page-number]")) {
    const pageNumber = Number(page.dataset.pageNumber)

    if (pageNumber > first && pageNumber < last) {
      pages.push([pageNumber, page])
    }
  }

  return pages.sort(([a], [b]) => a - b)
}

/** The selected part of a page's built spans, joined as `Range.toString`
    joins the runs, as the WebView's copy does within a page. Their own holder,
    not the layer: one being replaced can briefly hold the old spans beside them. */
function builtPart(range: Range, page: HTMLElement) {
  const holder =
    textPage(page)?.spans[0]?.parentElement ?? page.querySelector(".pdf-text-layer")

  return holder ? rangeWithin(range, holder).toString() : ""
}

export type SelectedPagesText = {
  /** Every page it runs over had its spans built: the WebView's copy has it all. */
  complete: boolean
  text: string | Promise<string>
}

/**
 * What a selection of page text holds, page by page, joined as the WebView's
 * copy joins pages. Spans exist only near the reader, so a page between the
 * ends that has none gives PDFium's whole text: a selection covering it
 * covers all of it. Null when the selection is not page text.
 */
export function selectedPagesText(
  selection: Selection | null,
  viewer?: Element,
): SelectedPagesText | null {
  const selected = selectedPages(selection)

  if (!selected || (viewer && selected.viewer !== viewer)) {
    return null
  }

  const { first, firstPage, last, lastPage, range } = selected
  const reader = readers.get(selected.viewer)
  const parts: (string | Promise<string>)[] = []
  let complete = true

  parts.push(builtPart(range, firstPage))

  for (const [pageNumber, page] of pagesBetween(selected)) {
    if (textPage(page) || !reader) {
      parts.push(builtPart(range, page))
    } else {
      complete = false
      parts.push(reader(pageNumber))
    }
  }

  if (last !== first) {
    parts.push(builtPart(range, lastPage))
  }

  const join = (texts: string[]) => texts.filter((text) => text !== "").join("\n")

  return {
    complete,
    text: parts.every((part) => typeof part === "string")
      ? join(parts as string[])
      : Promise.all(parts).then(join),
  }
}
