import { useEffect, type RefObject } from "react"

import {
  clampFraction,
  clientPointToFraction,
  fractionToPagePoint,
  type PagePoint,
} from "@/lib/annotationGeometry"
import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import type { PdfPageInfo } from "@/lib/pdf"

/**
 * How far the pointer may travel between press and release and still count as a
 * click, in CSS pixels. A press that wanders further was the reader changing
 * their mind or nudging the window, not aiming at a mark.
 */
const CLICK_SLOP = 4

type UseEraserToolOptions = {
  active: boolean
  onErase: (pageNumber: number, point: PagePoint) => void
  pages: PdfPageInfo[]
  rotations: PageRotations
  viewerRef: RefObject<HTMLElement | null>
}

/**
 * The eraser takes a mark off with a click on it: press and release on the same
 * spot, so a press that lands on the wrong mark can still be dragged off before
 * it counts. What is under the point is the backend's to answer — it holds the
 * annotations — so this only turns a click into a page and a point on it.
 */
export function useEraserTool({
  active,
  onErase,
  pages,
  rotations,
  viewerRef,
}: UseEraserToolOptions) {
  useEffect(() => {
    if (!active) {
      return
    }

    // The element rather than the box it had at `pointerdown`: the viewer still
    // scrolls under a pointer that has not itself moved, and the release is
    // measured against where the page is by then.
    let gesture: {
      element: Element
      page: PdfPageInfo
      pageNumber: number
      pointerId: number
      x: number
      y: number
    } | null = null

    const handlePointerDown = (event: PointerEvent) => {
      gesture = null

      // Only the primary button of the primary pointer erases, as with every
      // other tool: a right-click or a second finger is not aiming at a mark.
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

      // Suppress the text selection a press on the text layer would begin; the
      // click is aimed at a mark, not at the words under it.
      event.preventDefault()

      gesture = {
        element: pageElement,
        page,
        pageNumber,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      }
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return
      }

      const current = gesture

      gesture = null

      if (
        Math.abs(event.clientX - current.x) > CLICK_SLOP ||
        Math.abs(event.clientY - current.y) > CLICK_SLOP
      ) {
        return
      }

      onErase(
        current.pageNumber,
        fractionToPagePoint(
          clampFraction(
            clientPointToFraction(
              current.element.getBoundingClientRect(),
              event.clientX,
              event.clientY,
            ),
          ),
          current.page,
          rotationForPage(rotations, current.pageNumber),
        ),
      )
    }

    const handlePointerCancel = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.pointerId) {
        gesture = null
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("pointerup", handlePointerUp)
    document.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [active, onErase, pages, rotations, viewerRef])
}
