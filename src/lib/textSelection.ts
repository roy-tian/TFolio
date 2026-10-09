import {
  clampFraction,
  clientPointToFraction,
  fractionsToPageRect,
  mergeRectsByLine,
  type PagePointsRect,
} from "@/lib/annotationGeometry"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import { textPage } from "@/lib/textSelectionPage"

/**
 * Clipped to the span, not `Range.getClientRects`, which reports a rect for
 * every element the range encloses whole — e.g. the next page's whole canvas.
 */
export function selectedRectOfSpan(selection: Selection, span: Element) {
  const range = selection.getRangeAt(0)
  const spanRange = document.createRange()

  spanRange.selectNodeContents(span)

  const overlap = range.cloneRange()

  if (overlap.compareBoundaryPoints(Range.START_TO_START, spanRange) < 0) {
    overlap.setStart(spanRange.startContainer, spanRange.startOffset)
  }

  if (overlap.compareBoundaryPoints(Range.END_TO_END, spanRange) > 0) {
    overlap.setEnd(spanRange.endContainer, spanRange.endOffset)
  }

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
  const box = pageElement.getBoundingClientRect()
  const rects: PagePointsRect[] = []

  const mounted = textPage(pageElement)
  if (!mounted) return []
  const { spans, layout: { lineOfRun } } = mounted
  const { height } = dimensionsForRotation(page.rotation, page.width, page.height)
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
