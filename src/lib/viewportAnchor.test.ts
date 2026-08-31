import { describe, expect, test } from "bun:test"

import { anchorCorrection, anchorOnPage } from "./viewportAnchor"

const rect = (top: number, left = 100, width = 400, height = 500) => ({
  height,
  left,
  top,
  width,
})

describe("anchorOnPage", () => {
  test("records where in the page the point sits", () => {
    const anchor = anchorOnPage(3, rect(50), 300, 300)

    expect(anchor).toEqual({
      clientX: 300,
      clientY: 300,
      fractionX: 0.5,
      fractionY: 0.5,
      pageNumber: 3,
    })
  })

  test("keeps a point beside or above the page as a fraction outside 0..1", () => {
    const anchor = anchorOnPage(1, rect(50), 20, 0)!

    expect(anchor.fractionX).toBeCloseTo(-0.2)
    expect(anchor.fractionY).toBeCloseTo(-0.1)
  })

  test("refuses a page with no box to measure", () => {
    expect(anchorOnPage(1, rect(0, 0, 0, 0), 10, 10)).toBeNull()
  })
})

describe("anchorCorrection", () => {
  test("is nothing when the layout did not move", () => {
    const box = rect(50)
    const anchor = anchorOnPage(1, box, 300, 300)!

    expect(anchorCorrection(anchor, box)).toEqual({ left: 0, top: 0 })
  })

  // The bug this exists for: a viewport dragged narrower re-fits every page, so
  // the stack above the reader shrinks and the document slides under an offset
  // the browser keeps in pixels.
  test("takes up the slack of a document laid out at a new scale", () => {
    // Half of page 4 is above the reading line at clientY 0.
    const anchor = anchorOnPage(4, rect(-250), 300, 0)!
    expect(anchor.fractionY).toBe(0.5)

    // Re-fitted to half the height, and the three pages above it took the whole
    // document up with them: the same point now sits 425px below the line.
    const correction = anchorCorrection(anchor, rect(300, 100, 200, 250))

    expect(correction.top).toBe(425)
  })

  test("holds the horizontal point a narrower column re-centres", () => {
    const anchor = anchorOnPage(1, rect(0, 100, 400, 500), 300, 0)!

    // The same page, laid out 100px further left: scrolling left by that much
    // is what puts the point back under the reader's eye.
    expect(anchorCorrection(anchor, rect(0, 0, 400, 500)).left).toBe(-100)
  })

  test("reports the correction for a page that is no longer on screen", () => {
    const anchor = anchorOnPage(9, rect(-1000), 300, 0)!

    expect(anchorCorrection(anchor, rect(-500)).top).toBe(500)
  })
})
