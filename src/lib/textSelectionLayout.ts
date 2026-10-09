import { mergeRectsByLine, type PagePointsRect } from "@/lib/annotationGeometry"

export type TextLine = PagePointsRect & { runs: number[] }

/** Build from complete runs, never the changing selection. A short glyph must
    not move a row's hit target or its painted top while the pointer passes it. */
export function textLines(rects: PagePointsRect[]): TextLine[] {
  const lines = mergeRectsByLine(rects).map((rect) => ({ ...rect, runs: [] as number[] }))
  // Sweep only bands crossing this ink top, rather than searching all rows
  // for every glyph on a fragmented page.
  const ordered = rects.map((rect, index) => ({ rect, index }))
    .sort((a, b) => a.rect.top - b.rect.top)
  let nextLine = 0
  let active: TextLine[] = []
  for (const { rect, index } of ordered) {
    while (nextLine < lines.length && lines[nextLine].top <= rect.top + 0.01) {
      active.push(lines[nextLine++])
    }
    active = active.filter(line => line.top + line.height >= rect.top - 0.01)
    active.find(line => contains(line, rect))?.runs.push(index)
  }
  for (const line of lines) {
    line.runs.sort((a, b) => rects[a].left - rects[b].left)
  }
  return lines
}

function contains(outer: PagePointsRect, inner: PagePointsRect) {
  return inner.left >= outer.left - 0.01 &&
    inner.top >= outer.top - 0.01 &&
    inner.left + inner.width <= outer.left + outer.width + 0.01 &&
    inner.top + inner.height <= outer.top + outer.height + 0.01
}

/** The row `textLines` gave the run holding `rect`. Bands can overlap, and the
    first one around a sub-run box need not be the band its run belongs to. */
export function lineOfRect(lines: TextLine[], rects: PagePointsRect[], rect: PagePointsRect) {
  let first: TextLine | undefined
  for (const line of lines) {
    if (!contains(line, rect)) continue
    if (line.runs.some(index => contains(rects[index], rect))) return line
    first ??= line
  }
  return first
}

function distance(value: number, start: number, length: number) {
  return Math.max(start - value, value - start - length, 0)
}

function overlapsColumn(a: TextLine, b: TextLine) {
  return Math.min(a.left + a.width, b.left + b.width) > Math.max(a.left, b.left)
}

function nearestRow(lines: TextLine[], x: number, y: number) {
  let best: TextLine | undefined
  let vertical = Infinity
  let horizontal = Infinity
  for (const line of lines) {
    const dy = distance(y, line.top, line.height)
    const dx = distance(x, line.left, line.width)
    if (dy < vertical || (dy === vertical && dx < horizontal)) {
      best = line
      vertical = dy
      horizontal = dx
    }
  }
  return best
}

/** Row navigation is vertical within a column, including its right margin and
    the space below its final line. A longer preceding row must not win simply
    because its ink extends under x. Moving into another column/cell explicitly
    switches that track, rather than mixing x/y distances at every glyph. */
export function nearestTextLine(lines: TextLine[], x: number, y: number, previous?: TextLine): TextLine | undefined {
  // A band whose runs all went to an overlapping band has no caret to offer.
  const candidates = lines.filter(line => line.runs.length > 0)
  const underX = candidates.filter(line => distance(x, line.left, line.width) === 0)
  const target = nearestRow(underX, x, y)
  let column = previous
  if (target && (!column || !overlapsColumn(column, target))) {
    column = target
  }
  // A heading across both columns overlaps either one: the line nearest the
  // pointer under x decides which column it leads into.
  const track = candidates.filter(line =>
    (!column || overlapsColumn(column, line)) && (!target || overlapsColumn(target, line)),
  )
  return nearestRow(track, x, y)
}

export function nearestTextRun(line: TextLine, rects: PagePointsRect[], x: number) {
  return line.runs.reduce((best, index) =>
    distance(x, rects[index].left, rects[index].width) <
    distance(x, rects[best].left, rects[best].width) ? index : best,
  )
}
