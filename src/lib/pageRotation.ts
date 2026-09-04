import type { ViewMode } from "@/lib/viewMode"

/** Clockwise viewer rotation for each 1-based page position. */
export type PageRotations = readonly number[]

/** The rotation a page position carries, with an upright fallback. */
export function rotationForPage(
  rotations: PageRotations,
  pageNumber: number,
) {
  return rotations[pageNumber - 1] ?? 0
}

/**
 * One press of the rotate button. Reading views always turn the whole
 * document. The thumbnail grid turns only its selection, except that an empty
 * or complete selection means the whole document too.
 */
export function rotationsAfterRotate(
  rotations: PageRotations,
  viewMode: ViewMode,
  selectedPages: ReadonlySet<number>,
): number[] {
  const rotateAll =
    viewMode !== "thumbnail" ||
    selectedPages.size === 0 ||
    rotations.every((_, index) => selectedPages.has(index + 1))

  return rotations.map((rotation, index) =>
    rotateAll || selectedPages.has(index + 1)
      ? (rotation + 90) % 360
      : rotation,
  )
}

/** Keeps positional rotations in range when a structure edit changes length. */
export function rotationsForPageCount(
  rotations: PageRotations,
  pageCount: number,
): number[] {
  return Array.from(
    { length: pageCount },
    (_, index) => rotations[index] ?? 0,
  )
}
