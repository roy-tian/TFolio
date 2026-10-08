import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"

/** A point inside a box, as a fraction of its size from the top-left corner. */
export type BoxFraction = {
  x: number
  y: number
}

/** A point in unrotated page points, from the page's top-left corner. */
export type PagePoint = {
  left: number
  top: number
}

/** A rectangle in unrotated page points, top-left origin — the space annotation
    payloads use; the backend flips it to PDFium's origin at the boundary. */
export type PagePointsRect = {
  height: number
  left: number
  top: number
  width: number
}

/** Content turns by the page's `/Rotate`, and that whole box again by the
    reader's rotation; about a common centre, the two compose into one. */
export function totalPageRotation(page: PdfPageInfo, rotation: number) {
  return (((rotation + page.rotation) % 360) + 360) % 360
}

/** Quarter turns are the whole domain — the toolbar steps by 90°, `/Rotate` is a
    multiple of it — so this is a swap and a flip of fractions, not trigonometry. */
export function unrotateFraction(
  fraction: BoxFraction,
  degrees: number,
): BoxFraction {
  switch (degrees) {
    case 90:
      return { x: fraction.y, y: 1 - fraction.x }
    case 180:
      return { x: 1 - fraction.x, y: 1 - fraction.y }
    case 270:
      return { x: 1 - fraction.y, y: fraction.x }
    default:
      return { x: fraction.x, y: fraction.y }
  }
}

export function rotateFraction(
  fraction: BoxFraction,
  degrees: number,
): BoxFraction {
  switch (degrees) {
    case 90:
      return { x: 1 - fraction.y, y: fraction.x }
    case 180:
      return { x: 1 - fraction.x, y: 1 - fraction.y }
    case 270:
      return { x: fraction.y, y: 1 - fraction.x }
    default:
      return { x: fraction.x, y: fraction.y }
  }
}

function unrotatedPageSize(page: PdfPageInfo) {
  return dimensionsForRotation(page.rotation, page.width, page.height)
}

/** `fraction` is measured against the footprint box — the element carrying
    `data-page-number`, axis-aligned however the page inside it turns. */
export function fractionToPagePoint(
  fraction: BoxFraction,
  page: PdfPageInfo,
  rotation: number,
): PagePoint {
  const unrotated = unrotateFraction(fraction, totalPageRotation(page, rotation))
  const { height, width } = unrotatedPageSize(page)

  return { left: unrotated.x * width, top: unrotated.y * height }
}

/** The corners are resolved independently and then squared up: a rotation can
    carry one to any side of the other. */
export function fractionsToPageRect(
  from: BoxFraction,
  to: BoxFraction,
  page: PdfPageInfo,
  rotation: number,
): PagePointsRect {
  const start = fractionToPagePoint(from, page, rotation)
  const end = fractionToPagePoint(to, page, rotation)

  return {
    height: Math.abs(end.top - start.top),
    left: Math.min(start.left, end.left),
    top: Math.min(start.top, end.top),
    width: Math.abs(end.left - start.left),
  }
}

/** The way back out of page space, so a screen-space text editor can sit over a
    page point — the page layer turns, and nobody wants to type at 90°. */
export function pagePointToFraction(
  point: PagePoint,
  page: PdfPageInfo,
  rotation: number,
): BoxFraction {
  const { height, width } = unrotatedPageSize(page)
  const unrotated = {
    x: width > 0 ? point.left / width : 0,
    y: height > 0 ? point.top / height : 0,
  }

  return rotateFraction(unrotated, totalPageRotation(page, rotation))
}

export function clientPointToFraction(
  box: { height: number; left: number; top: number; width: number },
  clientX: number,
  clientY: number,
): BoxFraction {
  return {
    x: box.width > 0 ? (clientX - box.left) / box.width : 0,
    y: box.height > 0 ? (clientY - box.top) / box.height : 0,
  }
}

/** The inverse of `clientPointToFraction`, against the same box. */
export function fractionToClientPoint(
  box: { height: number; left: number; top: number; width: number },
  fraction: BoxFraction,
): { x: number; y: number } {
  return {
    x: box.left + fraction.x * box.width,
    y: box.top + fraction.y * box.height,
  }
}

/** Holds `fraction` inside its box, for a run that reached past the page's edge. */
export function clampFraction(fraction: BoxFraction): BoxFraction {
  return {
    x: Math.min(1, Math.max(0, fraction.x)),
    y: Math.min(1, Math.max(0, fraction.y)),
  }
}

/** Runs whose extents overlap by more than this fraction of the shorter one
    share a text line; less is neighbouring lines whose leading merely touches. */
const SAME_LINE_OVERLAP = 0.5

/** A run up to this many line-heights out from the band still belongs to the
    line — the page's spacing stretched it — but a column gutter stands wider. */
const MAX_RUN_GAP = 1.5

/**
 * One band per text line, the shape a selection or a highlight reads as: whole
 * from the line's first run to its last, across the gaps the page's spacing
 * left between runs — but not across a column gutter, which sorting would
 * otherwise pin onto the line at the same height. Run boxes carry ink heights
 * that differ per script and per glyph, so unmerged they tile a line in bands
 * of varying height and slits.
 */
export function mergeRectsByLine(rects: PagePointsRect[]): PagePointsRect[] {
  if (rects.length < 2) {
    return rects
  }

  const pending = [...rects].sort(
    (left, right) => left.top - right.top || left.left - right.left,
  )
  const rows: { top: number; bottom: number; rects: PagePointsRect[] }[] = []
  let active: typeof rows = []

  // Ink tops vary within one line. Find the rows first, then visit each row
  // left to right: a jump between tall glyphs must not look like a gutter
  // before the shorter glyphs between them have been considered.
  for (const rect of pending) {
    active = active.filter((row) => row.bottom > rect.top)
    const row = active.find((row) => {
      const overlap = Math.min(row.bottom, rect.top + rect.height) - rect.top

      return overlap > SAME_LINE_OVERLAP * Math.min(row.bottom - row.top, rect.height)
    })

    if (row) {
      row.bottom = Math.max(row.bottom, rect.top + rect.height)
      row.rects.push(rect)
    } else {
      const next = { top: rect.top, bottom: rect.top + rect.height, rects: [rect] }
      rows.push(next)
      active.push(next)
    }
  }

  const bands: PagePointsRect[] = []

  for (const row of rows) {
    row.rects.sort((left, right) => left.left - right.left)
    const lineBands: PagePointsRect[] = []

    for (const rect of row.rects) {
      // A tall heading in another column can put several body lines in this
      // vertical group. Match each run to a local band, not the group's height.
      const band = lineBands.find((candidate) => {
        const overlap =
          Math.min(candidate.top + candidate.height, rect.top + rect.height) -
          Math.max(candidate.top, rect.top)
        const gap = rect.left - (candidate.left + candidate.width)

        return (
          overlap > SAME_LINE_OVERLAP * Math.min(candidate.height, rect.height) &&
          gap <= MAX_RUN_GAP * Math.max(candidate.height, rect.height)
        )
      })

      if (!band) {
        lineBands.push({ ...rect })
        continue
      }

      const top = Math.min(band.top, rect.top)

      band.height = Math.max(band.top + band.height, rect.top + rect.height) - top
      band.top = top
      band.width = Math.max(band.left + band.width, rect.left + rect.width) - band.left
    }

    bands.push(...lineBands)
  }

  return bands.sort((left, right) => left.top - right.top || left.left - right.left)
}
