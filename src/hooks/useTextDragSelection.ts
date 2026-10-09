import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import { clientPointToFraction, fractionToPagePoint, totalPageRotation } from "@/lib/annotationGeometry"
import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import type { PdfPageInfo } from "@/lib/pdf"
import { isMacOS } from "@/lib/platform"
import { caretInTextRun, type TextCaret } from "@/lib/textCaret"
import { nearestTextLine, nearestTextRun, type TextLine } from "@/lib/textSelectionLayout"
import { textPageAtPoint, type MountedTextPage } from "@/lib/textSelectionPage"

type Options = {
  enabled: boolean
  pages: PdfPageInfo[]
  rotations: PageRotations
  viewerRef: RefObject<HTMLElement | null>
}

function scrollStep(position: number, start: number, end: number) {
  const distance = position < start ? position - start : position > end ? position - end : 0
  return Math.sign(distance) * Math.min(24, Math.abs(distance) / 3)
}

/** Own drag targeting in whitespace, but keep a real DOM Selection for copy,
    keyboard extension, context menus and annotations. Native caret lookup is
    confined to the chosen run, never allowed to redirect us to another row.
    Returns `finish`, which settles a drag at a release point and ends it. */
export function useTextDragSelection({ enabled, pages, rotations, viewerRef }: Options) {
  const finishRef = useRef<(x: number, y: number) => void>(() => {})
  // Read per event: a new pages array or rotations object must not end a drag.
  // Not useEffectEvent: React 19.2 never refreshes one in a forwardRef or memo
  // component, such as DocumentSession, so it would keep the first rotation.
  const geometry = useRef({ pages, rotations })
  useLayoutEffect(() => {
    geometry.current = { pages, rotations }
  })

  useEffect(() => {
    const viewer = viewerRef.current
    if (!enabled || !viewer) return

    const macOS = isMacOS()

    function pageAt(number: number) {
      const { pages, rotations } = geometry.current
      const page = pages[number - 1]
      return page && { page, rotation: rotationForPage(rotations, number) }
    }

    let anchor: TextCaret | null = null
    let frame = 0
    let pointer = { x: 0, y: 0 }
    let previous: { mounted: MountedTextPage; line: TextLine } | null = null
    let dirty = false

    function caretAt(x: number, y: number): TextCaret | null {
      const mounted = textPageAtPoint(viewer!, x, y)
      if (!mounted) return null
      const target = pageAt(Number(mounted.element.getAttribute("data-page-number")))
      if (!target) return null
      const { page, rotation } = target
      const box = mounted.element.getBoundingClientRect()
      const point = fractionToPagePoint(clientPointToFraction(box, x, y), page, rotation)
      const { lines, rects } = mounted.layout
      const line = nearestTextLine(lines, point.left, point.top,
        previous?.mounted === mounted ? previous.line : undefined)
      if (!line) return null
      previous = { mounted, line }
      const index = nearestTextRun(line, rects, point.left)
      const rect = rects[index]
      return caretInTextRun(mounted.spans[index], (point.left - rect.left) / rect.width,
        totalPageRotation(page, rotation))
    }

    function update() {
      if (!anchor?.node.isConnected) {
        stop()
        return
      }
      const focus = caretAt(pointer.x, pointer.y)
      const selection = window.getSelection()
      if (!focus || !selection) return
      // Atomic replacement avoids a transient collapsed selection (and flash).
      if (selection.anchorNode !== anchor.node || selection.anchorOffset !== anchor.offset ||
          selection.focusNode !== focus.node || selection.focusOffset !== focus.offset) {
        selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
      }
    }

    function tick() {
      if (!anchor) return
      const box = viewer!.getBoundingClientRect()
      const dx = scrollStep(pointer.x, box.left, box.right)
      const dy = scrollStep(pointer.y, box.top, box.bottom)
      const { scrollLeft, scrollTop } = viewer!
      if (dx || dy) viewer!.scrollBy(dx, dy)
      // Held past a scroll limit, nothing under the pointer moves.
      if (dirty || viewer!.scrollLeft !== scrollLeft || viewer!.scrollTop !== scrollTop) {
        dirty = false
        update()
      }
      if (anchor) frame = requestAnimationFrame(tick)
    }

    function stop() {
      anchor = null
      cancelAnimationFrame(frame)
      previous = null
      dirty = false
    }

    function finish(x: number, y: number) {
      if (!anchor) return
      pointer = { x, y }
      update()
      stop()
    }
    finishRef.current = finish

    const scroll = () => { dirty = true }
    const down = (event: MouseEvent) => {
      // macOS Control-click opens the context menu; a drag would collapse the
      // selection that menu copies.
      if (event.button !== 0 || event.detail > 1 || (macOS && event.ctrlKey) ||
          !(event.target instanceof Element) || !event.target.closest(".pdf-text-layer")) return
      stop()
      pointer = { x: event.clientX, y: event.clientY }
      const caret = caretAt(pointer.x, pointer.y)
      if (!caret) return
      const selection = window.getSelection()
      anchor = event.shiftKey && selection?.anchorNode instanceof Text &&
        viewer.contains(selection.anchorNode) ? { node: selection.anchorNode, offset: selection.anchorOffset } : caret
      event.preventDefault()
      // Cancelling mousedown also cancels focus transfer from an input.
      viewer.focus({ preventScroll: true })
      update()
      frame = requestAnimationFrame(tick)
    }
    const move = (event: MouseEvent) => {
      if (!anchor) return
      if (!(event.buttons & 1)) {
        stop()
        return
      }
      event.preventDefault()
      pointer = { x: event.clientX, y: event.clientY }
      dirty = true
    }
    const up = (event: MouseEvent) => {
      if (event.button === 0) finish(event.clientX, event.clientY)
    }
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") stop() }
    viewer.addEventListener("mousedown", down)
    viewer.addEventListener("scroll", scroll, { passive: true })
    document.addEventListener("mousemove", move)
    // Touch compatibility mousedown can follow pointerup: end on mouseup.
    document.addEventListener("mouseup", up, true)
    document.addEventListener("pointercancel", stop)
    window.addEventListener("blur", stop)
    document.addEventListener("keydown", key)
    return () => {
      stop()
      finishRef.current = () => {}
      viewer.removeEventListener("mousedown", down)
      viewer.removeEventListener("scroll", scroll)
      document.removeEventListener("mousemove", move)
      document.removeEventListener("mouseup", up, true)
      document.removeEventListener("pointercancel", stop)
      window.removeEventListener("blur", stop)
      document.removeEventListener("keydown", key)
    }
  }, [enabled, viewerRef])

  return useCallback((x: number, y: number) => finishRef.current(x, y), [])
}
