import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import {
  DRAG_MOTION,
  ENTER_MOTION,
  EXIT_MOTION,
  prefersReducedMotion,
} from "@/lib/motion"

type Offset = { x: number; y: number }
type Place = Offset & { height: number; width: number }

/** The layout a change of contents replaces. */
type Snapshot = {
  cells: Map<string, HTMLElement>
  places: Map<string, Place>
  /** Where each cell caught mid-slide shows, which is not its place. */
  shown: Map<string, Offset>
}

// Slides wholly beyond this far out of the window are skipped: nobody sees them.
const OFFSCREEN_MARGIN = 200
const SHRUNK = "scale(0.9)"

const keyedCells = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>("[data-flip-key]")

const placeOf = (cell: HTMLElement): Place => ({
  height: cell.offsetHeight,
  width: cell.offsetWidth,
  x: cell.offsetLeft,
  y: cell.offsetTop,
})

function measurePlaces(container: HTMLElement) {
  const places = new Map<string, Place>()

  for (const cell of keyedCells(container)) {
    places.set(cell.dataset.flipKey!, placeOf(cell))
  }

  return places
}

/** A box this far down the window, and this tall, is near enough to be seen. */
const inSight = (top: number, height: number) =>
  top < innerHeight + OFFSCREEN_MARGIN && top + height > -OFFSCREEN_MARGIN

function takeSnapshot(
  container: HTMLElement | null,
  slides: ReadonlyMap<string, Animation>,
): Snapshot | null {
  if (!container || prefersReducedMotion() || container.getClientRects().length === 0) {
    return null
  }

  const cells = new Map<string, HTMLElement>()
  const places = new Map<string, Place>()
  const shown = new Map<string, Offset>()

  for (const cell of keyedCells(container)) {
    cells.set(cell.dataset.flipKey!, cell)
    places.set(cell.dataset.flipKey!, placeOf(cell))
  }

  const origin = container.getBoundingClientRect()

  for (const [key, slide] of slides) {
    const cell = cells.get(key)

    if (cell && slide.playState === "running") {
      const box = cell.getBoundingClientRect()

      shown.set(key, { x: box.left - origin.left, y: box.top - origin.top })
    }
  }

  return { cells, places, shown }
}

/** A cell React has let go of, kept on show while it fades where it stood: a
    picture of itself, which no selector, pointer, focus or screen reader finds. */
function ghostOf(cell: HTMLElement, place: Place, at: Offset) {
  for (const element of [cell, ...cell.querySelectorAll("*")]) {
    for (const name of element.getAttributeNames()) {
      if (
        name.startsWith("data-") ||
        name.startsWith("aria-") ||
        name === "id" ||
        name === "role"
      ) {
        element.removeAttribute(name)
      }
    }
  }

  cell.inert = true
  cell.setAttribute("aria-hidden", "true")
  Object.assign(cell.style, {
    height: `${place.height}px`,
    left: `${at.x}px`,
    margin: "0",
    pointerEvents: "none",
    position: "absolute",
    top: `${at.y}px`,
    width: `${place.width}px`,
  })

  return cell
}

/**
 * Slides each `[data-flip-key]` element from where it stood to where the latest
 * render laid it out: while `enabled`, the render that clears it included, from
 * the places `prime` took; and whenever `contents` changes, from the layout that
 * change replaced, fading in the keys it brings and out the keys it drops. A
 * resize or the size control still jumps.
 *
 * Places are `offsetLeft`/`offsetTop`, which ignore the slides' transforms, so
 * the container must be every keyed element's offset parent: positioned, with
 * nothing positioned in between. They are scroll-free too, so edge scrolling
 * mid-drag moves nothing. A leaving element fades as the container's own child,
 * before every other: whatever reads the container's children must pass over
 * any without a key.
 */
export function useFlipLayout(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** What the keyed elements are drawn from; compared by identity. */
  contents: unknown,
) {
  const placesRef = useRef<Map<string, Place> | null>(null)
  const slidesRef = useRef(new Map<string, Animation>())
  const leavingRef = useRef(new Map<string, HTMLElement>())
  const enabledRef = useRef(false)
  const contentsRef = useRef(contents)
  const snapshotRef = useRef<Snapshot | null>(null)

  // Read in render, the one moment the layout a commit replaces is still
  // there: hooks have no getSnapshotBeforeUpdate. Every render of new contents
  // reads again, so the one that commits holds the layout it replaced.
  if (contents !== contentsRef.current) {
    snapshotRef.current = takeSnapshot(containerRef.current, slidesRef.current)
  }

  const prime = useCallback(() => {
    const container = containerRef.current

    placesRef.current =
      container && !prefersReducedMotion() ? measurePlaces(container) : null
  }, [containerRef])

  useEffect(() => {
    const leaving = leavingRef.current

    return () => {
      for (const ghost of leaving.values()) {
        ghost.remove()
      }

      leaving.clear()
    }
  }, [])

  // Every render: a drag re-renders the owner only when its landing changes.
  useLayoutEffect(() => {
    const container = containerRef.current
    const snapshot = contents !== contentsRef.current ? snapshotRef.current : null
    const before = snapshot?.places ?? placesRef.current
    const tracking = enabled || enabledRef.current

    contentsRef.current = contents
    snapshotRef.current = null
    enabledRef.current = enabled

    if (!container || !before || !(tracking || snapshot)) {
      placesRef.current = null
      return
    }

    const origin = container.getBoundingClientRect()
    const places = measurePlaces(container)
    const slides = slidesRef.current
    const leaving = leavingRef.current
    const moves: { cell: HTMLElement; key: string; x: number; y: number }[] = []
    const entering: HTMLElement[] = []
    const stopped: string[] = []

    // All reads before any write, so the batch lays out once.
    for (const cell of keyedCells(container)) {
      const key = cell.dataset.flipKey!
      const was = before.get(key)
      const place = places.get(key)!

      if (!was) {
        if (snapshot && inSight(origin.top + place.y, place.height)) {
          entering.push(cell)
        }

        continue
      }

      // A slide under way on an unmoved cell already ends where it stands:
      // restarting it would stretch it and jolt its easing.
      if (was.x === place.x && was.y === place.y) {
        continue
      }

      let x = was.x - place.x
      let y = was.y - place.y
      // Read before the commit: a cell remounted elsewhere shows no slide now.
      const caught = snapshot?.shown.get(key)

      // Caught mid-slide: start from where it shows, which is its old place
      // plus whatever offset the slide had reached.
      if (caught) {
        x = caught.x - place.x
        y = caught.y - place.y
      } else if (slides.get(key)?.playState === "running") {
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

    if (snapshot) {
      // Back before its last fade has ended, as an undo brings it: the fade
      // gives way to the cell itself.
      for (const [key, ghost] of leaving) {
        if (places.has(key)) {
          ghost.remove()
          leaving.delete(key)
        }
      }

      for (const [key, cell] of snapshot.cells) {
        const was = snapshot.places.get(key)!
        const at = snapshot.shown.get(key) ?? was

        if (places.has(key) || cell.isConnected) {
          continue
        }

        slides.get(key)?.cancel()
        slides.delete(key)

        if (was.width === 0 || !inSight(origin.top + at.y, was.height)) {
          continue
        }

        const ghost = ghostOf(cell, was, at)

        // First, so the cells closing up over its place pass in front of it.
        container.prepend(ghost)
        leaving.set(key, ghost)

        const fade = ghost.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: SHRUNK },
          ],
          // Held at its end until it is taken away, rather than flash back.
          { ...EXIT_MOTION, fill: "forwards" },
        )

        fade.onfinish = () => {
          ghost.remove()

          if (leaving.get(key) === ghost) {
            leaving.delete(key)
          }
        }
      }

      for (const cell of entering) {
        cell.animate(
          [
            { opacity: 0, transform: SHRUNK },
            { opacity: 1, transform: "none" },
          ],
          ENTER_MOTION,
        )
      }
    }

    placesRef.current = enabled ? places : null
  })

  return { prime }
}
