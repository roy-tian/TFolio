export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Pages sliding aside for a drag and a dragged page settling into place. */
export const DRAG_MOTION = {
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
} as const
