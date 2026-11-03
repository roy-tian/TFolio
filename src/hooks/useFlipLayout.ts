import { useCallback, useLayoutEffect, useRef, type RefObject } from "react"

import { DRAG_MOTION, prefersReducedMotion } from "@/lib/motion"

type Place = { x: number; y: number }

// Slides wholly beyond this far out of the window are skipped: nobody sees them.
const OFFSCREEN_MARGIN = 200

function measurePlaces(container: HTMLElement) {
  const places = new Map<string, Place>()

  for (const cell of container.querySelectorAll<HTMLElement>("[data-flip-key]")) {
    places.set(cell.dataset.flipKey!, { x: cell.offsetLeft, y: cell.offsetTop })
  }

  return places
}

/**
 * Slides each `[data-flip-key]` element from where it stood to where the latest
 * render laid it out. Only while `enabled`, the render that clears it included,
 * and from the places `prime` took: a resize or the size control still jumps.
 *
 * Places are `offsetLeft`/`offsetTop`, which ignore the slides' transforms, so
 * the container must be every keyed element's offset parent: positioned, with
 * nothing positioned in between. They are scroll-free too, so edge scrolling
 * mid-drag moves nothing.
 */
export function useFlipLayout(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const placesRef = useRef<Map<string, Place> | null>(null)
  const slidesRef = useRef(new Map<string, Animation>())
  const enabledRef = useRef(false)

  const prime = useCallback(() => {
    const container = containerRef.current

    placesRef.current =
      container && !prefersReducedMotion() ? measurePlaces(container) : null
  }, [containerRef])

  // Every render: a drag re-renders the owner only when its landing changes.
  useLayoutEffect(() => {
    const container = containerRef.current
    const before = placesRef.current
    const tracking = enabled || enabledRef.current

    enabledRef.current = enabled

    if (!container || !before || !tracking) {
      placesRef.current = null
      return
    }

    const origin = container.getBoundingClientRect()
    const places = measurePlaces(container)
    const slides = slidesRef.current
    const moves: { cell: HTMLElement; key: string; x: number; y: number }[] = []
    const stopped: string[] = []

    // All reads before any write, so the batch lays out once.
    for (const cell of container.querySelectorAll<HTMLElement>("[data-flip-key]")) {
      const key = cell.dataset.flipKey!
      const was = before.get(key)
      const place = places.get(key)!

      // A slide under way on an unmoved cell already ends where it stands:
      // restarting it would stretch it and jolt its easing.
      if (!was || (was.x === place.x && was.y === place.y)) {
        continue
      }

      let x = was.x - place.x
      let y = was.y - place.y

      // Caught mid-slide: start from where it shows, which is its old place
      // plus whatever offset the slide had reached.
      if (slides.get(key)?.playState === "running") {
        const shown = cell.getBoundingClientRect()

        x += shown.left - origin.left - place.x
        y += shown.top - origin.top - place.y
      }

      const top = origin.top + place.y

      if (
        (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) ||
        (top + y > innerHeight + OFFSCREEN_MARGIN && top > innerHeight + OFFSCREEN_MARGIN) ||
        (top + y + cell.offsetHeight < -OFFSCREEN_MARGIN &&
          top + cell.offsetHeight < -OFFSCREEN_MARGIN)
      ) {
        stopped.push(key)
        continue
      }

      moves.push({ cell, key, x, y })
    }

    for (const key of stopped) {
      slides.get(key)?.cancel()
      slides.delete(key)
    }

    for (const { cell, key, x, y } of moves) {
      slides.get(key)?.cancel()

      const slide = cell.animate(
        [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }],
        DRAG_MOTION,
      )

      // Kept past its end, a slide would hold its cell after the cell is gone.
      slide.onfinish = () => {
        if (slides.get(key) === slide) {
          slides.delete(key)
        }
      }
      slides.set(key, slide)
    }

    placesRef.current = enabled ? places : null
  })

  return { prime }
}
