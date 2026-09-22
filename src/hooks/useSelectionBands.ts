import { useEffect, useMemo, useState, type RefObject } from "react"

import {
  mergeRectsByLine,
  type PagePointsRect,
} from "@/lib/annotationGeometry"
import { selectedLineRectsOnPage } from "@/lib/textSelection"
import type { PdfPageInfo, PdfTextSpan } from "@/lib/pdf"

type UseSelectionBandsOptions = {
  /** An element inside the page whose selection these bands paint; the page
      itself is found from it, wherever the surface's own tree grows. */
  anchorRef: RefObject<HTMLElement | null>
  page: PdfPageInfo
  rotation: number
  /** The app's own select-all, which no document range stands for. */
  selectAll: boolean
  /** The page's extracted runs, in page points — select-all's whole geometry. */
  spans: PdfTextSpan[]
}

const NO_BANDS: PagePointsRect[] = []

/** A fresh array of the same bands would repaint the surface; a page a
    cross-page drag merely covers must not do that every selection change. */
function sameBands(current: PagePointsRect[], next: PagePointsRect[]) {
  return (
    current.length === next.length &&
    current.every(
      (rect, index) =>
        rect.height === next[index].height &&
        rect.left === next[index].left &&
        rect.top === next[index].top &&
        rect.width === next[index].width,
    )
  )
}

/**
 * The selection painted over one page: a band per text line, not the WebView's
 * own per-run tint, so the highlight runs unbroken and level across a line the
 * way a reader expects it — see `mergeRectsByLine`. Bands are page points, so
 * what is painted survives zoom and rotation without recomputing.
 */
export function useSelectionBands({
  anchorRef,
  page,
  rotation,
  selectAll,
  spans,
}: UseSelectionBandsOptions) {
  const [bands, setBands] = useState(NO_BANDS)

  // Select-all stands for pages virtualisation never mounted a range over, so
  // its bands come from the extracted geometry, not from any DOM selection.
  const selectAllBands = useMemo(
    () =>
      selectAll
        ? mergeRectsByLine(
            spans.map((span) => ({
              height: span.height,
              left: span.left,
              top: span.top,
              width: span.width,
            })),
          )
        : NO_BANDS,
    [selectAll, spans],
  )

  useEffect(() => {
    if (selectAll) {
      setBands((current) => (current.length === 0 ? current : []))

      return
    }

    const update = () => {
      const pageElement = anchorRef.current?.closest("[data-page-number]")
      const selection = window.getSelection()

      if (
        !pageElement ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !selection.containsNode(pageElement, true)
      ) {
        setBands((current) => (current.length === 0 ? current : []))

        return
      }

      const next = selectedLineRectsOnPage(selection, pageElement, page, rotation)

      setBands((current) => (sameBands(current, next) ? current : next))
    }

    update()

    // selectionchange fires at input-event rate while a drag runs, but the
    // preview can show only one recomputation per frame; the rest is dropped.
    let frame = 0
    const schedule = () => {
      if (frame) {
        return
      }

      frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }

    document.addEventListener("selectionchange", schedule)

    return () => {
      document.removeEventListener("selectionchange", schedule)

      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [anchorRef, page, rotation, selectAll])

  return selectAll ? selectAllBands : bands
}
