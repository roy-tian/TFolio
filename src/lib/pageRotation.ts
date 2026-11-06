export const QUARTER_TURN = 90

/**
 * In a reading view the turn is a way of looking, not an edit: the whole
 * document turns, pages a structure edit brings in with it, and nothing is
 * written to the file. See `pagesToRotate`.
 */
export function turnView(viewRotation: number) {
  return (viewRotation + QUARTER_TURN) % 360
}

/**
 * From the previews the turn is an edit of the document: the selection, or every
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
