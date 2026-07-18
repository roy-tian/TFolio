import { describe, expect, it } from "bun:test"

import type { BoxFraction } from "@/lib/annotationGeometry"
import {
  isRectLargeEnough,
  MIN_RECT_POINTS,
  normalizeFractionRect,
} from "@/lib/rectDraft"

const topLeft: BoxFraction = { x: 0.2, y: 0.3 }
const bottomRight: BoxFraction = { x: 0.6, y: 0.8 }
const topRight: BoxFraction = { x: 0.6, y: 0.3 }
const bottomLeft: BoxFraction = { x: 0.2, y: 0.8 }

describe("normalizeFractionRect", () => {
  it("gives the same rectangle whichever corner the drag started from", () => {
    const expected = { height: 0.5, left: 0.2, top: 0.3, width: 0.4 }

    for (const [from, to] of [
      [topLeft, bottomRight],
      [bottomRight, topLeft],
      [topRight, bottomLeft],
      [bottomLeft, topRight],
    ] satisfies [BoxFraction, BoxFraction][]) {
      const rect = normalizeFractionRect(from, to)

      expect(rect.left).toBeCloseTo(expected.left)
      expect(rect.top).toBeCloseTo(expected.top)
      expect(rect.width).toBeCloseTo(expected.width)
      expect(rect.height).toBeCloseTo(expected.height)
    }
  })

  it("collapses to a point when the corners coincide", () => {
    const rect = normalizeFractionRect(topLeft, topLeft)

    expect(rect.width).toBe(0)
    expect(rect.height).toBe(0)
  })
})

describe("isRectLargeEnough", () => {
  it("accepts a rectangle at least a few points on each side", () => {
    expect(
      isRectLargeEnough({ height: 40, left: 0, top: 0, width: 80 }),
    ).toBe(true)
  })

  it("rejects a drag too small on either side to have been meant", () => {
    expect(
      isRectLargeEnough({
        height: 80,
        left: 0,
        top: 0,
        width: MIN_RECT_POINTS - 1,
      }),
    ).toBe(false)
    expect(
      isRectLargeEnough({
        height: MIN_RECT_POINTS - 1,
        left: 0,
        top: 0,
        width: 80,
      }),
    ).toBe(false)
  })
})
