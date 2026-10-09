import { mergeRectsByLine, type PagePointsRect } from "@/lib/annotationGeometry"
import { lineOfRect } from "@/lib/textSelectionLayout"
import type { TextPageLayout } from "@/lib/textSelectionPage"

/** Search returns tight ink boxes; selection paints each run's full row, then
    merges per line. Doing the same here keeps a hit level with a selection of
    the same text without extending it over unsearched text. */
export function searchHighlightRects(
  rects: PagePointsRect[],
  { lines, rects: runs }: TextPageLayout,
): PagePointsRect[] {
  return mergeRectsByLine(rects.map((rect) => {
    const line = lineOfRect(lines, runs, rect)
    return line ? { ...rect, top: line.top, height: line.height } : rect
  }))
}
