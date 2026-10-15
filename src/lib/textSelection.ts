import {
  clampFraction,
  clientPointToFraction,
  fractionsToPageRect,
  mergeRectsByLine,
  type PagePointsRect,
} from "@/lib/annotationGeometry"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import { pageRuns, textPage, textPageLayout } from "@/lib/textSelectionPage"

/** The part of `range` inside `node`; collapsed where the two do not meet,
    since moving one end past the other collapses a range. */
export function rangeWithin(range: Range, node: Node) {
  const part = document.createRange()

  part.selectNodeContents(node)

  if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
    part.setStart(range.startContainer, range.startOffset)
  }

  if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
    part.setEnd(range.endContainer, range.endOffset)
  }

  return part
}

/**
 * Clipped to the span, not `Range.getClientRects`, which reports a rect for
 * every element the range encloses whole — e.g. the next page's whole canvas.
 */
export function selectedRectOfSpan(selection: Selection, span: Element) {
  const overlap = rangeWithin(selection.getRangeAt(0), span)

  return overlap.collapsed ? null : overlap.getBoundingClientRect()
}

/**
 * The selection's footprint on one page, one band per text line: the selected
 * stretch of every run it touches, merged across the line with its run-mates.
 * In unrotated page points, so the bands survive zoom and rotation unchanged.
 */
export function selectedLineRectsOnPage(
  selection: Selection,
  pageElement: Element,
  page: PdfPageInfo,
  rotation: number,
): PagePointsRect[] {
  const mounted = textPage(pageElement)
  const { height, width } = dimensionsForRotation(page.rotation, page.width, page.height)

  if (!mounted) {
    // Spans exist only near the view, so a page between a selection's ends
    // may have none to measure; taken in whole, it is every line it has.
    const runs = pageRuns(pageElement)

    return runs && selection.containsNode(pageElement, false)
      ? textPageLayout(runs).lines.flatMap((line) => {
          // A band whose runs all went to an overlapping one would mark twice.
          if (line.runs.length === 0) return []
          const left = Math.max(0, line.left)
          const top = Math.max(0, line.top)
          const right = Math.min(width, line.left + line.width)
          const bottom = Math.min(height, line.top + line.height)

          return right > left && bottom > top
            ? [{ height: bottom - top, left, top, width: right - left }]
            : []
        })
      : []
  }

  const box = pageElement.getBoundingClientRect()
  const rects: PagePointsRect[] = []
  const { spans, layout: { lineOfRun } } = mounted
  const pageRect = (rect: DOMRect) => fractionsToPageRect(
    clampFraction(clientPointToFraction(box, rect.left, rect.top)),
    clampFraction(clientPointToFraction(box, rect.right, rect.bottom)),
    page,
    rotation,
  )
  for (const [index, span] of spans.entries()) {
    if (!selection.containsNode(span, true)) {
      continue
    }

    const rect = selectedRectOfSpan(selection, span)

    if (!rect) {
      continue
    }

    // A span stretched to the width PDFium reported can reach past the page's
    // edge, and a band taken outside it would paint past the page.
    const band = pageRect(rect)
    const line = lineOfRun.get(index)
    if (line) {
      band.top = Math.max(0, line.top)
      band.height = Math.min(height, line.top + line.height) - band.top
    }

    if (band.width > 0 && band.height > 0) {
      rects.push(band)
    }
  }

  return mergeRectsByLine(rects)
}
