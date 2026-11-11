/** A blank page a Save As puts after page `after`, the size it shows at: the
    engine's `SectionBook::padding`, sent with every structure change. */
export type PaddingSheet = { after: number; height: number; width: number }

/** What a reading view lays out: the document's pages, with the blank pages
    a Save As will add standing where it will put them. */
export type Sheet = { kind: "page"; pageNumber: number } | ({ kind: "padding" } & PaddingSheet)

/** A document of one file has none: shared, so the empty list stays one value. */
export const NO_PADDING: readonly PaddingSheet[] = []

/** The 0-based positions a blank follows, for pages whose files stand as
    `files` says, position by position: the engine's `SectionBook::padding`,
    for a preview it has not laid out. Before a file that would otherwise
    start on an even page, as the back of the last leaf of the file before. */
export function paddingPositions(files: readonly (number | undefined)[]): number[] {
  if (new Set(files).size < 2) {
    return []
  }

  const after: number[] = []
  let written = 0

  files.forEach((file, index) => {
    if (index > 0 && file !== files[index - 1] && written % 2 === 1) {
      after.push(index - 1)
      written += 1
    }

    written += 1
  })

  return after
}

export function samePadding(left: readonly PaddingSheet[], right: readonly PaddingSheet[]) {
  return (
    left.length === right.length &&
    left.every(
      (sheet, index) =>
        sheet.after === right[index]!.after &&
        sheet.width === right[index]!.width &&
        sheet.height === right[index]!.height,
    )
  )
}

export function sheetsOf(pageCount: number, padding: readonly PaddingSheet[]): Sheet[] {
  const after = new Map(padding.map((sheet) => [sheet.after, sheet]))
  const sheets: Sheet[] = []

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    sheets.push({ kind: "page", pageNumber })

    const blank = after.get(pageNumber)

    if (blank) {
      sheets.push({ kind: "padding", ...blank })
    }
  }

  return sheets
}

/** Two sheets to a spread, the first on the left; a lone last sheet keeps
    the left slot. A blank always stands on the right, so every spread starts
    with a page. */
export function sheetSpreads(sheets: readonly Sheet[]): Sheet[][] {
  const spreads: Sheet[][] = []

  for (let index = 0; index < sheets.length; index += 2) {
    spreads.push(sheets.slice(index, index + 2))
  }

  return spreads
}

/** The pages of the spread holding `pageNumber`. */
export function spreadPagesOf(spreads: readonly Sheet[][], pageNumber: number): number[] {
  const spread = spreads.find((row) =>
    row.some((sheet) => sheet.kind === "page" && sheet.pageNumber === pageNumber),
  )

  return (spread ?? []).flatMap((sheet) => (sheet.kind === "page" ? [sheet.pageNumber] : []))
}

/** A book turn's destination: the first page of the next or previous spread,
    staying put at either end. */
export function spreadTurnTarget(
  spreads: readonly Sheet[][],
  pageNumber: number,
  direction: -1 | 1,
): number {
  const at = spreads.findIndex((row) =>
    row.some((sheet) => sheet.kind === "page" && sheet.pageNumber === pageNumber),
  )
  const next = spreads[Math.min(spreads.length - 1, Math.max(0, at + direction))]
  const first = next?.[0]

  return first?.kind === "page" ? first.pageNumber : pageNumber
}
