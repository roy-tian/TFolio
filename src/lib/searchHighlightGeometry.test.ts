import { describe, expect, it } from "bun:test"

import { searchHighlightRects } from "@/lib/searchHighlightGeometry"
import { textPageLayout } from "@/lib/textSelectionPage"

const box = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height,
})

describe("search highlight geometry", () => {
  it("uses the same full-row height as mouse selection, even for a short glyph", () => {
    const spans = [box(10, 20, 10, 14), box(20, 24, 20, 7), box(40, 22, 10, 10)]
    const layout = textPageLayout(spans)
    const hit = box(25, 25, 5, 6)
    const line = layout.lineOfRun.get(1)!
    expect(searchHighlightRects([hit], layout)).toEqual([
      { ...hit, top: line.top, height: line.height },
    ])
    expect(line.height).toBe(14)
    expect(hit).toEqual(box(25, 25, 5, 6))
  })

  it("levels fragmented hits before merging and keeps wrapped lines separate", () => {
    const layout = textPageLayout([box(10, 20, 80, 14), box(10, 40, 80, 16)])
    expect(searchHighlightRects([
      box(20, 24, 10, 6), box(33, 23, 12, 8), box(10, 44, 20, 7),
    ], layout)).toEqual([box(20, 20, 25, 14), box(10, 40, 20, 16)])
  })

  it("takes its run's band where an earlier band also surrounds the hit", () => {
    // The first row's band spans the gap its two runs leave, over the top of
    // the next row's run; selection paints the hit with that run's own band.
    const spans = [box(0, 0, 40, 20), box(60, 0, 40, 20), box(42, 12, 16, 20)]
    const layout = textPageLayout(spans)
    expect(layout.lines).toHaveLength(2)
    expect(searchHighlightRects([box(45, 13, 5, 6)], layout)).toEqual([
      box(45, 12, 5, 20),
    ])
  })

  it("does not borrow height from another column or a touching row", () => {
    const layout = textPageLayout([
      box(10, 10, 40, 30), box(150, 20, 70, 10), box(150, 30, 70, 12),
    ])
    expect(searchHighlightRects([box(160, 23, 8, 7)], layout)).toEqual([
      box(160, 20, 8, 10),
    ])
  })

  it("keeps ink geometry outside every row", () => {
    const hits = [box(10, 20, 8, 6), box(10, 40, 8, 6)]
    expect(searchHighlightRects(hits, textPageLayout([]))).toEqual(hits)
    expect(searchHighlightRects(hits, textPageLayout([box(150, 20, 80, 14)]))).toEqual(hits)
    expect(searchHighlightRects([], textPageLayout([box(10, 20, 80, 14)]))).toEqual([])
  })
})
