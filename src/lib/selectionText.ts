import { finishTextLayersIn } from "@/lib/textLayerBuild"
import { rangeWithin } from "@/lib/textSelection"
import type { TextLine } from "@/lib/textSelectionLayout"
import { textPage, textPagesIn } from "@/lib/textSelectionPage"

/** PDFium's text for a page: at once when it has been read, else a promise
    that settles with "" rather than rejecting. Only a read a copy will `wait`
    for goes ahead of the renders and outlives the selection moving on. */
export type PageTextReader = (pageNumber: number, wait: boolean) => string | Promise<string>

const readers = new WeakMap<Element, PageTextReader>()

/** A viewer's session lends it the reader for the pages between a selection's
    ends. */
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

/** The selected part of a page's built spans, in PDFium's own form: runs keep
    the spaces PDFium puts between words but carry no line breaks, so one goes
    wherever consecutive runs sit on different lines. */
function builtPart(range: Range, page: Element) {
  const mounted = textPage(page)

  // Spans not yet built, or midway through a rebuild: what stands in the
  // layer is all there is.
  if (!mounted) {
    const layer = page.querySelector(".pdf-text-layer")

    return layer ? rangeWithin(range, layer).toString() : ""
  }

  const { spans, layout: { lineOfRun } } = mounted
  let text = ""
  let line: TextLine | undefined

  for (const [index, span] of spans.entries()) {
    if (!range.intersectsNode(span)) {
      continue
    }

    // Only a span holding an end is cut; a fragmented page has a thousand.
    const part =
      span.contains(range.startContainer) || span.contains(range.endContainer)
        ? rangeWithin(range, span).toString()
        : (span.textContent ?? "")

    if (part === "") {
      continue
    }

    // A run no line took in cannot be said to start one.
    const runLine = lineOfRun.get(index) ?? line

    if (text !== "" && runLine !== line) {
      text += "\n"
    }

    line = runLine
    text += part
  }

  return text
}

/**
 * What a selection of page text holds, in the form the whole document's copy
 * takes from PDFium: a page between the ends is PDFium's text for it, from
 * its spans only while PDFium is still reading it, and pages stand a blank
 * line apart. Null when the selection is not page text or its viewer lends
 * no reader.
 */
export function selectedPagesText(
  selection: Selection | null,
  viewer?: Element,
): string | Promise<string> | null {
  const selected = selectedPages(selection)

  if (!selected || (viewer && selected.viewer !== viewer)) {
    return null
  }

  const reader = readers.get(selected.viewer)

  if (!reader) {
    return null
  }

  const { first, firstPage, last, lastPage, range } = selected

  // A drag or a key can reach into pages that just came near and are still
  // building their spans; an end can sit on the layer rather than in a span.
  finishTextLayersIn(range)

  const built = new Map<number, Element>()

  for (const { element } of textPagesIn(selected.viewer)) {
    const pageNumber = Number(element.getAttribute("data-page-number"))

    if (pageNumber > first && pageNumber < last) {
      built.set(pageNumber, element)
    }
  }

  // PDFium trims each page, so neither end keeps whitespace at a page break;
  // a one-page copy keeps the selection as it is.
  const opening = builtPart(range, firstPage)
  const parts: (string | Promise<string>)[] = [last === first ? opening : opening.trimEnd()]

  for (let pageNumber = first + 1; pageNumber < last; pageNumber += 1) {
    const page = built.get(pageNumber)
    const text = reader(pageNumber, !page)

    // Still being read, but near enough to have spans: waiting would write
    // the clipboard after the key, which refuses it, so the spans stand in.
    parts.push(typeof text !== "string" && page ? builtPart(range, page).trim() : text)
  }

  if (last !== first) {
    parts.push(builtPart(range, lastPage).trimStart())
  }

  const join = (texts: string[]) => texts.filter((text) => text !== "").join("\n\n")

  return parts.every((part) => typeof part === "string")
    ? join(parts as string[])
    : Promise.all(parts).then(join)
}
