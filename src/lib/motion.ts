export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Hidden, or out of the window: a turn of every page would otherwise lay out
    hundreds of papers each frame for nobody. */
export function isOutOfSight(element: Element) {
  if (element.getClientRects().length === 0) {
    return true
  }

  const box = element.getBoundingClientRect()

  return box.bottom < 0 || box.top > window.innerHeight
}

/** Pages sliding aside for a drag and a dragged page settling into place. */
export const DRAG_MOTION = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
} as const

/** A page joining a list, as the pages around it slide aside. */
export const ENTER_MOTION = DRAG_MOTION

/** A page leaving a list: gone before the pages closing up behind it settle. */
export const EXIT_MOTION = {
  duration: 150,
  easing: "cubic-bezier(0.3, 0, 1, 1)",
} as const

/** A page turning a quarter, its footprint swapping sides as it spins. */
export const TURN_MOTION = { duration: 250, easing: "ease-out" } as const
