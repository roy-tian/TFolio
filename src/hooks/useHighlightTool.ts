import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

import type { PagePointsRect } from "@/lib/annotationGeometry"
import type { HighlightCommand, HighlightTarget } from "@/lib/annotations"
import { selectedLineRectsOnPage } from "@/lib/textSelection"
import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import { isMacOS } from "@/lib/platform"
import type { PdfPageInfo } from "@/lib/pdf"

type UseHighlightToolOptions = {
  active: boolean
  color: string
  /** Settles a text drag at the release point before its selection is read. */
  finishTextDrag: (x: number, y: number) => void
  onCommit: (command: HighlightCommand) => void
  opacity: number
  pages: PdfPageInfo[]
  rotations: PageRotations
  selectable: boolean
  viewerRef: RefObject<HTMLElement | null>
}

// Below this a line is a stray click through the text layer, not a mark.
const MIN_QUAD_POINTS = 0.5

function quadsOnPage(
  selection: Selection,
  pageElement: Element,
  page: PdfPageInfo,
  rotation: number,
): PagePointsRect[] {
  // A band per line, which is the shape a PDF highlight wants: one per line
  // rather than a box around the lot — and what the drag previewed.
  return selectedLineRectsOnPage(selection, pageElement, page, rotation).filter(
    (quad) => quad.width > MIN_QUAD_POINTS && quad.height > MIN_QUAD_POINTS,
  )
}

function selectionTargets(
  selection: Selection,
  viewer: HTMLElement,
  pages: PdfPageInfo[],
  rotations: PageRotations,
): HighlightTarget[] {
  if (selection.isCollapsed || selection.rangeCount === 0) {
    return []
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

    const quads = quadsOnPage(
      selection,
      pageElement,
      page,
      rotationForPage(rotations, pageNumber),
    )

    if (quads.length > 0) {
      targets.push({ pageNumber, quads })
    }
  }

  return targets
}

/** Reads the selection as it stands and returns the commit that highlights it,
    or null when nothing selected would leave a mark. */
export type CaptureHighlight = () => (() => void) | null

/**
 * The selection is the preview for free: the text layer is already selectable,
 * and nothing reaches the backend until the gesture is over.
 */
export function useHighlightTool({
  active,
  color,
  finishTextDrag,
  onCommit,
  opacity,
  pages,
  rotations,
  selectable,
  viewerRef,
}: UseHighlightToolOptions) {
  const [selectionDragging, setSelectionDragging] = useState(false)

  // Read when called, not depended on: every mounted page holds the capture,
  // and a fresh one would re-render them all.
  const latest = useRef({ color, onCommit, opacity, pages, rotations })
  useLayoutEffect(() => {
    latest.current = { color, onCommit, opacity, pages, rotations }
  })

  // Shared by the tool's drag and the page menu, which marks in the tool's
  // colour whether or not the tool is chosen.
  const captureSelection = useCallback<CaptureHighlight>(() => {
    const viewer = viewerRef.current
    const selection = window.getSelection()

    if (!viewer || !selection) {
      return null
    }

    const { color, onCommit, opacity, pages, rotations } = latest.current
    const targets = selectionTargets(selection, viewer, pages, rotations)

    if (targets.length === 0) {
      return null
    }

    return () => {
      onCommit({ color, kind: "highlight", opacity, targets })
      // The browser's tint has done its job; leaving it would double up with the
      // drawn highlight.
      window.getSelection()?.removeAllRanges()
    }
  }, [viewerRef])

  useEffect(() => {
    if (!selectable) {
      setSelectionDragging(false)
      return
    }

    const macOS = isMacOS()
    // A selection outlives its drag, so committing on any pointerup would mark
    // a stale one when the reader pressed Undo — and then have nothing to undo.
    let startedOnText = false

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target

      // A context-menu click is no drag: marking on its release would also
      // leave the menu's own highlight item to mark the same text twice.
      startedOnText =
        event.button === 0 &&
        !(macOS && event.ctrlKey) &&
        target instanceof Element &&
        target.closest(".pdf-text-layer") !== null
      setSelectionDragging(startedOnText)
    }

    // Bound on the document: a drag that runs off the page still ends there.
    const handlePointerUp = (event: PointerEvent) => {
      if (!startedOnText) {
        setSelectionDragging(false)
        return
      }

      startedOnText = false
      setSelectionDragging(false)

      if (!active) {
        return
      }

      // Pointerup arrives before the mouseup that ends a text drag, whose
      // selection otherwise still lags the release point by up to a frame.
      finishTextDrag(event.clientX, event.clientY)
      captureSelection()?.()
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
  }, [active, captureSelection, finishTextDrag, selectable])

  return { captureSelection, selectionDragging }
}
