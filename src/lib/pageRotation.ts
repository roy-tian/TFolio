export type PageRotations = readonly number[]

export const QUARTER_TURN = 90

export function rotationForPage(
  rotations: PageRotations,
  pageNumber: number,
) {
  return rotations[pageNumber - 1] ?? 0
}

/**
 * In a reading view the turn is a way of looking, not an edit: the whole
 * document turns and nothing is written to the file. See `pagesToRotate`.
 */
export function rotationsAfterRotate(rotations: PageRotations): number[] {
  return rotations.map((rotation) => (rotation + QUARTER_TURN) % 360)
}

/**
 * In the grid the turn is an edit of the document: the selection, or every
 * page when there is none — which come to the same list when all are selected.
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

export function rotationsForPageCount(
  rotations: PageRotations,
  pageCount: number,
): number[] {
  return Array.from(
    { length: pageCount },
    (_, index) => rotations[index] ?? 0,
  )
}
