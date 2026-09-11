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

/** A live or released preview, in fractions of one page's on-screen box. */
export type RectDraft = {
  id: number
  pageNumber: number
  rect: FractionRect
  style: RectStyle
  /** Present only once the backend has accepted this released rectangle. */
  renderEpoch?: number
}

/**
 * A rectangle is dragged out corner to corner, previewed live, and only written
 * to the backend once the drag is over. Unlike a highlight there is no native
 * selection to lean on, so this keeps its own draft — but nothing crosses the
 * IPC boundary until `pointerup`, so a drag is never a burst of render calls.
 * Released drafts keep their identity until a bitmap containing their commit
 * is painted; another gesture or tool change only clears the live draft.
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

    // Which page the drag started on. A rectangle belongs to one page: the drag
    // locks to whichever the pointer went down on, and running off it clamps
    // rather than switches page. The pointer id ties the move and release back
    // to this same press.
    //
    // The element, not the box it had at `pointerdown`: the viewer still scrolls
    // and zooms mid-drag, which moves the page under a pointer that has not
    // itself moved. Measured against a stale box the rectangle would land as far
    // from the pointer as the page had travelled.
    let gesture: {
      id: number
      element: Element
      from: BoxFraction
      page: PdfPageInfo
      pageNumber: number
      pointerId: number
    } | null = null

    const handlePointerDown = (event: PointerEvent) => {
      // Every press clears a drag the last one left unfinished, whatever it
      // lands on — otherwise a release lost off-window would leave a live
      // gesture, and the next click anywhere would commit it as a rectangle.
      gesture = null
      setDraft(null)

      // Only the primary button of the primary pointer draws: a right- or
      // middle-click, or a second finger, clears a stale drag but starts none.
      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      const viewer = viewerRef.current
      const target = event.target

      if (!viewer || !(target instanceof Element) || !viewer.contains(target)) {
        return
      }

      const pageElement = target.closest("[data-page-number]")

      // Started off any page — a toolbar click, the margin — so it is not a
      // draw. Without this, pressing a button would leave a rectangle.
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
