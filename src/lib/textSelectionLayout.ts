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
    const line = active.find(line =>
      rect.left >= line.left - 0.01 &&
      rect.left + rect.width <= line.left + line.width + 0.01 &&
      rect.top + rect.height <= line.top + line.height + 0.01,
    )
    line?.runs.push(index)
  }
  for (const line of lines) {
    line.runs.sort((a, b) => rects[a].left - rects[b].left)
  }
  return lines
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
