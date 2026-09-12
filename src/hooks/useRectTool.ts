import { useEffect, useState, type RefObject } from "react"

import { useReleasedPreviews } from "@/hooks/useReleasedPreviews"
import {
  clampFraction,
  clientPointToFraction,
  fractionsToPageRect,
  type BoxFraction,
} from "@/lib/annotationGeometry"
import type { RectCommand, RectStyle, RenderEpochs } from "@/lib/annotations"
import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import type { PdfPageInfo } from "@/lib/pdf"
import {
  isRectLargeEnough,
  normalizeFractionRect,
  type FractionRect,
} from "@/lib/rectDraft"

type UseRectToolOptions = {
  active: boolean
  onCommit: (
    command: RectCommand,
    onApplied: (epochs: RenderEpochs) => void,
  ) => Promise<boolean>
  pages: PdfPageInfo[]
  rotations: PageRotations
  style: RectStyle
  viewerRef: RefObject<HTMLElement | null>
}

export type RectDraft = {
  id: number
  pageNumber: number
  rect: FractionRect
  style: RectStyle
  /** Present only once the backend has accepted this released rectangle. */
  renderEpoch?: number
}

/**
 * No native selection to lean on, so this keeps its own draft, but nothing
 * crosses IPC until `pointerup`; released drafts live until repainted.
 */
export function useRectTool({
  active,
  onCommit,
  pages,
  rotations,
  style,
  viewerRef,
}: UseRectToolOptions) {
  const [draft, setDraft] = useState<RectDraft | null>(null)
  const { onPagePaint, previews, release, takeId } =
    useReleasedPreviews<RectDraft>()

  useEffect(() => {
    if (!active) {
      setDraft(null)
      return
    }

    // The drag locks to the page it began on — off it clamps, not switches.
    // The element, not a `pointerdown` box: the page moves under it mid-drag.
    let gesture: {
      id: number
      element: Element
      from: BoxFraction
      page: PdfPageInfo
      pageNumber: number
      pointerId: number
    } | null = null

    const handlePointerDown = (event: PointerEvent) => {
      // Every press clears an unfinished drag: a release lost off-window must
      // not leave a live gesture the next click commits as a rectangle.
      gesture = null
      setDraft(null)

      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      const viewer = viewerRef.current
      const target = event.target

      if (!viewer || !(target instanceof Element) || !viewer.contains(target)) {
        return
      }

      const pageElement = target.closest("[data-page-number]")

      if (!pageElement) {
        return
      }

      const pageNumber = Number(pageElement.getAttribute("data-page-number"))
      const page = pages[pageNumber - 1]

      if (!page) {
        return
      }

      // Suppress the text selection a drag over the text layer would otherwise
      // start; the rectangle is the gesture, not a selection.
      event.preventDefault()
      // Keep the rest of the drag — including its release — aimed at this page
      // even if the pointer leaves the window, so a drag can never be stranded.
      try {
        pageElement.setPointerCapture(event.pointerId)
      } catch {
        // A synthetic pointer (a test) has nothing to capture; the document
        // listeners carry the gesture regardless.
      }

      const from = clampFraction(
        clientPointToFraction(
          pageElement.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        ),
      )

      gesture = {
        id: takeId(),
        element: pageElement,
        from,
        page,
        pageNumber,
        pointerId: event.pointerId,
      }
      setDraft({
        id: gesture.id,
        pageNumber,
        rect: normalizeFractionRect(from, from),
        style,
      })
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      const to = clampFraction(
        clientPointToFraction(
          gesture.element.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        ),
      )

      setDraft({
        id: gesture.id,
        pageNumber: gesture.pageNumber,
        rect: normalizeFractionRect(gesture.from, to),
        style,
      })
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      const current = gesture

      gesture = null
      setDraft(null)

      const to = clampFraction(
        clientPointToFraction(
          current.element.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        ),
      )
      const bounds = fractionsToPageRect(
        current.from,
        to,
        current.page,
        rotationForPage(rotations, current.pageNumber),
      )

      if (!isRectLargeEnough(bounds)) {
        return
      }

      release(
        {
          id: current.id,
          pageNumber: current.pageNumber,
          rect: normalizeFractionRect(current.from, to),
          style,
        },
        (onApplied) =>
          onCommit(
            {
              bounds,
              kind: "rect",
              pageNumber: current.pageNumber,
              style,
            },
            onApplied,
          ),
      )
    }

    // The pointer left for good — the OS took over a scroll or a gesture — so
    // the drag is abandoned rather than committed to wherever it stopped.
    const handlePointerCancel = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      gesture = null
      setDraft(null)
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointermove", handlePointerMove)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointermove", handlePointerMove)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [active, onCommit, pages, release, rotations, style, takeId, viewerRef])

  return { drafts: draft ? [...previews, draft] : previews, onPagePaint }
}
