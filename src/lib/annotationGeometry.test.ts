import { describe, expect, it } from "bun:test"

import {
  clampFraction,
  clientPointToFraction,
  fractionsToPageRect,
  fractionToClientPoint,
  fractionToPagePoint,
  mergeRectsByLine,
  pagePointToFraction,
  rotateFraction,
  totalPageRotation,
  unrotateFraction,
  type BoxFraction,
  type PagePointsRect,
} from "@/lib/annotationGeometry"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"

// A page whose displayed size is 200x300. `rotation` is the intrinsic /Rotate,
// which the backend has already applied to `width`/`height`.
function page(rotation: number): PdfPageInfo {
  return { height: 300, rotation, width: 200 }
}

const rotations = [0, 90, 180, 270]

describe("unrotateFraction", () => {
  it("leaves an unrotated box alone", () => {
    expect(unrotateFraction({ x: 0.25, y: 0.75 }, 0)).toEqual({ x: 0.25, y: 0.75 })
  })

  // The four quarter turns are the whole domain, so they are pinned corner by
  // corner rather than trusted to a formula that reads plausibly.
  it("carries the footprint's corners back to the box's own", () => {
    const topLeft: BoxFraction = { x: 0, y: 0 }

    expect(unrotateFraction(topLeft, 90)).toEqual({ x: 0, y: 1 })
    expect(unrotateFraction(topLeft, 180)).toEqual({ x: 1, y: 1 })
    expect(unrotateFraction(topLeft, 270)).toEqual({ x: 1, y: 0 })
  })

  it("returns to the identity after four quarter turns", () => {
    let fraction: BoxFraction = { x: 0.3, y: 0.8 }

    for (let turn = 0; turn < 4; turn += 1) {
      fraction = unrotateFraction(fraction, 90)
    }

    expect(fraction.x).toBeCloseTo(0.3)
    expect(fraction.y).toBeCloseTo(0.8)
  })

  // Two quarter turns and one half turn are the same map, which is what lets
  // the page's own rotation and the reader's compose into a single one.
  it("composes: two quarter turns equal a half turn", () => {
    const start: BoxFraction = { x: 0.2, y: 0.6 }
    const twice = unrotateFraction(unrotateFraction(start, 90), 90)

    expect(twice).toEqual(unrotateFraction(start, 180))
  })

  it("is its own inverse at a half turn", () => {
    const start: BoxFraction = { x: 0.2, y: 0.6 }
    const twice = unrotateFraction(unrotateFraction(start, 180), 180)

    expect(twice.x).toBeCloseTo(start.x)
    expect(twice.y).toBeCloseTo(start.y)
  })
})

describe("totalPageRotation", () => {
  it("adds the reader's rotation to the page's own", () => {
    expect(totalPageRotation(page(90), 180)).toBe(270)
  })

  it("wraps past a full turn", () => {
    expect(totalPageRotation(page(270), 180)).toBe(90)
    expect(totalPageRotation(page(90), 270)).toBe(0)
  })
})

describe("fractionToPagePoint", () => {
  it("scales a fraction of an upright page to its points", () => {
    expect(fractionToPagePoint({ x: 0.5, y: 0.5 }, page(0), 0)).toEqual({
      left: 100,
      top: 150,
    })
  })

  // The centre is the one point every rotation fixes, so it holds whatever the
  // page and the reader are each doing.
  it("holds the centre still through every rotation pair", () => {
    for (const intrinsic of rotations) {
      for (const rotation of rotations) {
        const { height, width } = dimensionsForRotation(intrinsic, 200, 300)
        const centre = fractionToPagePoint(
          { x: 0.5, y: 0.5 },
          page(intrinsic),
          rotation,
        )

        expect(centre.left).toBeCloseTo(width / 2)
        expect(centre.top).toBeCloseTo(height / 2)
      }
    }
  })

  // Whatever the rotation, the four corners of the footprint have to land on the
  // four corners of the page — never off it, and never twice on the same one.
  it("maps the footprint's corners onto the page's corners, one each", () => {
    const corners: BoxFraction[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]

    for (const intrinsic of rotations) {
      for (const rotation of rotations) {
        const { height, width } = dimensionsForRotation(intrinsic, 200, 300)
        const mapped = corners.map((corner) => {
          const point = fractionToPagePoint(corner, page(intrinsic), rotation)

          return `${Math.round(point.left)},${Math.round(point.top)}`
        })

        expect(new Set(mapped).size).toBe(4)

        for (const point of mapped) {
          expect([`0,0`, `${width},0`, `${width},${height}`, `0,${height}`]).toContain(
            point,
          )
        }
      }
    }
  })

  // Pinned because the corner-set test above would pass just as happily on a map
  // that turned the page the wrong way: the top-left must land at the top-right.
  it("places a quarter turn's corners where the page is actually drawn", () => {
    expect(fractionToPagePoint({ x: 1, y: 0 }, page(0), 90)).toEqual({
      left: 0,
      top: 0,
    })
    expect(fractionToPagePoint({ x: 0, y: 0 }, page(0), 90)).toEqual({
      left: 0,
      top: 300,
    })
  })
})

describe("fractionsToPageRect", () => {
  it("squares up a rectangle drawn right and down", () => {
    expect(
      fractionsToPageRect({ x: 0.1, y: 0.2 }, { x: 0.6, y: 0.7 }, page(0), 0),
    ).toEqual({ height: 150, left: 20, top: 60, width: 100 })
  })

  it("gives the same rectangle whichever corner the drag started from", () => {
    const forward = fractionsToPageRect(
      { x: 0.1, y: 0.2 },
      { x: 0.6, y: 0.7 },
      page(0),
      0,
    )
    const backward = fractionsToPageRect(
      { x: 0.6, y: 0.7 },
      { x: 0.1, y: 0.2 },
      page(0),
      0,
    )

    expect(backward).toEqual(forward)
  })

  // The rectangle a drag encloses is the same patch of the page however the
  // page is turned while drawing it, so its area cannot move with the rotation.
  it("keeps a drag's area through every rotation pair", () => {
    for (const intrinsic of rotations) {
      for (const rotation of rotations) {
        const rect = fractionsToPageRect(
          { x: 0.25, y: 0.25 },
          { x: 0.75, y: 0.75 },
          page(intrinsic),
          rotation,
        )
        const { height, width } = dimensionsForRotation(intrinsic, 200, 300)

        expect(rect.width * rect.height).toBeCloseTo((width / 2) * (height / 2))
        expect(rect.left).toBeCloseTo(width / 4)
        expect(rect.top).toBeCloseTo(height / 4)
      }
    }
  })

  it("never reports a negative side", () => {
    for (const intrinsic of rotations) {
      for (const rotation of rotations) {
        const rect = fractionsToPageRect(
          { x: 0.8, y: 0.1 },
          { x: 0.2, y: 0.9 },
          page(intrinsic),
          rotation,
        )

        expect(rect.width).toBeGreaterThan(0)
        expect(rect.height).toBeGreaterThan(0)
      }
    }
  })
})

describe("clientPointToFraction", () => {
  it("measures a client point against the box", () => {
    const box = { height: 200, left: 50, top: 100, width: 400 }

    expect(clientPointToFraction(box, 250, 200)).toEqual({ x: 0.5, y: 0.5 })
  })

  it("reports a point outside the box outside 0..1", () => {
    const box = { height: 200, left: 50, top: 100, width: 400 }

    expect(clientPointToFraction(box, 50 - 40, 100).x).toBeCloseTo(-0.1)
  })

  // A page still laying out has no size to measure against, and dividing by it
  // would report NaN rather than simply nothing.
  it("reports the origin for a box with no size", () => {
    expect(clientPointToFraction({ height: 0, left: 0, top: 0, width: 0 }, 5, 5)).toEqual(
      { x: 0, y: 0 },
    )
  })
})

describe("clampFraction", () => {
  it("holds a fraction inside its box", () => {
    expect(clampFraction({ x: -0.5, y: 1.5 })).toEqual({ x: 0, y: 1 })
  })

  it("leaves a fraction already inside alone", () => {
    expect(clampFraction({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 })
  })
})

describe("rotateFraction", () => {
  // Inverseness is the whole of the contract: an editor placed with one and read
  // back with the other has to land where it started, at every turn.
  it("undoes unrotateFraction at every quarter turn", () => {
    const start: BoxFraction = { x: 0.3, y: 0.8 }

    for (const degrees of rotations) {
      const round = rotateFraction(unrotateFraction(start, degrees), degrees)

      expect(round.x).toBeCloseTo(start.x)
      expect(round.y).toBeCloseTo(start.y)
    }
  })

  // Pinned rather than left to the round trip above, which a pair of maps that
  // were each other's inverse but both wrong would satisfy just as well.
  it("carries the box's corner onto the footprint's", () => {
    const topLeft: BoxFraction = { x: 0, y: 0 }

    expect(rotateFraction(topLeft, 90)).toEqual({ x: 1, y: 0 })
    expect(rotateFraction(topLeft, 180)).toEqual({ x: 1, y: 1 })
    expect(rotateFraction(topLeft, 270)).toEqual({ x: 0, y: 1 })
  })
})

describe("pagePointToFraction", () => {
  it("is the inverse of fractionToPagePoint through every rotation pair", () => {
    const start: BoxFraction = { x: 0.2, y: 0.65 }

    for (const intrinsic of rotations) {
      for (const rotation of rotations) {
        const point = fractionToPagePoint(start, page(intrinsic), rotation)
        const round = pagePointToFraction(point, page(intrinsic), rotation)

        expect(round.x).toBeCloseTo(start.x)
        expect(round.y).toBeCloseTo(start.y)
      }
    }
  })

  it("puts a point on an upright page where it belongs", () => {
    expect(pagePointToFraction({ left: 100, top: 150 }, page(0), 0)).toEqual({
      x: 0.5,
      y: 0.5,
    })
  })

  // The same corner `fractionToPagePoint` is pinned against, read the other way,
  // so the two cannot drift apart.
  it("places a quarter turn's corner where the page is actually drawn", () => {
    expect(pagePointToFraction({ left: 0, top: 0 }, page(0), 90)).toEqual({
      x: 1,
      y: 0,
    })
  })

  it("reports the origin for a page with no size", () => {
    const empty = { height: 0, rotation: 0, width: 0 }

    expect(pagePointToFraction({ left: 5, top: 5 }, empty, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe("fractionToClientPoint", () => {
  it("is the inverse of clientPointToFraction", () => {
    const box = { height: 200, left: 50, top: 100, width: 400 }
    const round = fractionToClientPoint(box, clientPointToFraction(box, 250, 200))

    expect(round).toEqual({ x: 250, y: 200 })
  })

  it("measures a fraction back onto the box", () => {
    const box = { height: 200, left: 50, top: 100, width: 400 }

    expect(fractionToClientPoint(box, { x: 0.5, y: 0.5 })).toEqual({ x: 250, y: 200 })
  })
})

describe("mergeRectsByLine", () => {
  function rect(
    left: number,
    top: number,
    width: number,
    height: number,
  ): PagePointsRect {
    return { height, left, top, width }
  }

  it("leaves fewer than two runs alone", () => {
    expect(mergeRectsByLine([])).toEqual([])
    expect(mergeRectsByLine([rect(10, 20, 5, 8)])).toEqual([
      rect(10, 20, 5, 8),
    ])
  })

  it("spans one band across a line's runs, gaps included", () => {
    // CJK run, a justified gap, then a narrower Latin run, all on one line.
    const runs = [
      rect(100, 40, 160, 10.5),
      rect(275, 40, 24, 8),
      rect(100, 60, 120, 10.5),
    ]

    expect(mergeRectsByLine(runs)).toEqual([rect(100, 40, 199, 10.5), rect(100, 60, 120, 10.5)])
  })

  it("keeps a column gutter out of the band", () => {
    // Two columns, two lines: sorting pairs column one's line with column
    // two's at the same height, and only the gutter tells them apart.
    const columns = [
      rect(50, 100, 200, 10),
      rect(310, 100, 200, 10),
      rect(50, 114, 200, 10),
      rect(310, 114, 200, 10),
    ]

    expect(mergeRectsByLine(columns)).toEqual(columns)
  })

  it("keeps the gutter whichever column's run sorts first", () => {
    // The right column's ink box starts a point higher, so sorting places it
    // before the left column's run — the separation reads the same both ways.
    const columns = [
      rect(310, 100, 200, 10),
      rect(50, 101, 200, 9),
    ]

    expect(mergeRectsByLine(columns)).toEqual(columns)
  })

  it("levels a line whose runs sit at different heights", () => {
    // Punctuation boxes hug the baseline while ideographs stand full height.
    const runs = [rect(50, 43, 10, 4), rect(60, 40, 100, 10)]

    expect(mergeRectsByLine(runs)).toEqual([rect(50, 40, 110, 10)])
  })

  it("keeps neighbouring lines apart whose boxes merely touch", () => {
    // Line pitch 14 over 10-high ink: the boxes abut without overlapping.
    const runs = [rect(72, 100, 200, 10), rect(72, 114, 200, 10)]

    expect(mergeRectsByLine(runs)).toEqual(runs)
  })

  it("keeps a footnote marker that barely climbs the line as its own band", () => {
    // The marker overlaps the line by a third of its own height, not half.
    const line = rect(72, 100, 200, 10)
    const marker = rect(280, 98, 3, 3)
    const next = rect(72, 114, 200, 10)

    expect(mergeRectsByLine([line, marker, next])).toEqual([
      marker,
      line,
      next,
    ])
  })

  it("takes a marker sitting far enough onto the line with it", () => {
    // Two thirds of the marker stand inside the line: one band, level with it.
    const line = rect(72, 100, 200, 10)
    const marker = rect(280, 99, 3, 3)

    expect(mergeRectsByLine([line, marker])).toEqual([
      rect(72, 99, 211, 11),
    ])
  })
})
