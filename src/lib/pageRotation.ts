/** Clockwise viewer rotation for each 1-based page position. */
export type PageRotations = readonly number[]

/** What one press of the rotate button turns, either way it is taken. */
export const QUARTER_TURN = 90

/** The rotation a page position carries, with an upright fallback. */
export function rotationForPage(
  rotations: PageRotations,
  pageNumber: number,
) {
  return rotations[pageNumber - 1] ?? 0
}

/**
 * One press of the rotate button in a reading view, where the turn is the
 * reader's way of looking at the document and reaches no further: the whole
 * document turns, and nothing about it is written to the file. The grid's press
 * is the other thing entirely — see `pagesToRotate`.
 */
export function rotationsAfterRotate(rotations: PageRotations): number[] {
  return rotations.map((rotation) => (rotation + QUARTER_TURN) % 360)
}

/**
 * The pages one press of the rotate button turns in the thumbnail grid, where
 * the turn is an edit of the document itself: the selection, or every page when
 * there is no selection. A selection of every page comes to the same list, so
 * the two ways of asking for the whole document agree.
 */
export function pagesToRotate(
  pageCount: number,
  selectedPages: ReadonlySet<number>,
): number[] {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1)

  return selectedPages.size === 0
    ? pages
    : pages.filter((pageNumber) => selectedPages.has(pageNumber))
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
