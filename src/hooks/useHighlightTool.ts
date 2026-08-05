import { useEffect, useState, type RefObject } from "react"

import {
  clampFraction,
  clientPointToFraction,
  fractionsToPageRect,
  type PagePointsRect,
} from "@/lib/annotationGeometry"
import type { HighlightCommand, HighlightTarget } from "@/lib/annotations"
import type { PdfPageInfo } from "@/lib/pdf"

type UseHighlightToolOptions = {
  active: boolean
  color: string
  onCommit: (command: HighlightCommand) => void
  opacity: number
  pages: PdfPageInfo[]
  rotation: number
  /** Whether native text selection is available, even without the highlighter. */
  selectable: boolean
  viewerRef: RefObject<HTMLElement | null>
}

// Below this a run is a stray click through the text layer, not a mark.
const MIN_QUAD_POINTS = 0.5

/**
 * Clipped to the span rather than read off `Range.getClientRects`, which reports
 * a rectangle for every *element* the range encloses whole, not just for text.
 * A selection dragged across a page break encloses the next page's canvas, whose
 * rectangle is the whole page — enough to turn two lines into a page of yellow.
 */
function selectedRectOfSpan(selection: Selection, span: Element) {
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

/** The rectangles a selection covers on one page, in that page's own points. */
function quadsOnPage(
  selection: Selection,
  pageElement: Element,
  page: PdfPageInfo,
  rotation: number,
): PagePointsRect[] {
  const box = pageElement.getBoundingClientRect()
  const quads: PagePointsRect[] = []

  // A quad per run, which is the shape a PDF highlight wants: one per line
  // rather than a box around the lot.
  for (const span of pageElement.querySelectorAll(".pdf-text-layer span")) {
    if (!selection.containsNode(span, true)) {
      continue
    }

    const rect = selectedRectOfSpan(selection, span)

    if (!rect) {
      continue
    }

    // A span stretched to the width PDFium reported can reach past the page's
    // edge, and a quad written outside it would be carried into the file.
    const quad = fractionsToPageRect(
      clampFraction(clientPointToFraction(box, rect.left, rect.top)),
      clampFraction(clientPointToFraction(box, rect.right, rect.bottom)),
      page,
      rotation,
    )

    if (quad.width > MIN_QUAD_POINTS && quad.height > MIN_QUAD_POINTS) {
      quads.push(quad)
    }
  }

  return quads
}

/**
 * The selection is the preview, for free: the text layer is already selectable,
 * so the browser tints the run as the reader drags and this only reads the
 * result. Nothing reaches the backend until the gesture is over.
 */
export function useHighlightTool({
  active,
  color,
  onCommit,
  opacity,
  pages,
  rotation,
  selectable,
  viewerRef,
}: UseHighlightToolOptions) {
  const [selectionDragging, setSelectionDragging] = useState(false)

  useEffect(() => {
    if (!selectable) {
      setSelectionDragging(false)
      return
    }

    // A selection outlives the drag that made it and survives a button click, so
    // committing on any pointerup would mark a stale selection when the reader
    // pressed Undo — and then have nothing to undo.
    let startedOnText = false

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target

      startedOnText =
        target instanceof Element && target.closest(".pdf-text-layer") !== null
      setSelectionDragging(startedOnText)
    }

    // Bound on the document: a drag that runs off the page still ends there.
    const handlePointerUp = () => {
      if (!startedOnText) {
        setSelectionDragging(false)
        return
      }

      startedOnText = false
      setSelectionDragging(false)

      if (!active) {
        return
      }

      const viewer = viewerRef.current
      const selection = window.getSelection()

      if (!viewer || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        return
      }

      const targets: HighlightTarget[] = []

      for (const pageElement of viewer.querySelectorAll("[data-page-number]")) {
        if (!selection.containsNode(pageElement, true)) {
          continue
        }

        const pageNumber = Number(pageElement.getAttribute("data-page-number"))
        const page = pages[pageNumber - 1]

        if (!page) {
          continue
        }

        const quads = quadsOnPage(selection, pageElement, page, rotation)

        if (quads.length > 0) {
          targets.push({ pageNumber, quads })
        }
      }

      if (targets.length === 0) {
        return
      }

      onCommit({ color, kind: "highlight", opacity, targets })
      // The browser's tint has done its job; leaving it would double up with the
      // drawn highlight.
      selection.removeAllRanges()
    }

    const handlePointerCancel = () => {
      startedOnText = false
      setSelectionDragging(false)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointercancel", handlePointerCancel)
    document.addEventListener("pointerup", handlePointerUp)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointercancel", handlePointerCancel)
      document.removeEventListener("pointerup", handlePointerUp)
    }
  }, [active, color, onCommit, opacity, pages, rotation, selectable, viewerRef])

  return selectionDragging
}
