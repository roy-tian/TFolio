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
