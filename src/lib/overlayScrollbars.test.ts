import { describe, expect, test } from "bun:test"

import { MIN_THUMB_SIZE, scrollPerThumbPixel, thumbGeometry } from "./overlayScrollbars"

describe("thumbGeometry", () => {
  test("sizes the thumb to the share of the content in view", () => {
    expect(thumbGeometry(0, 1000, 250, 200)).toEqual({ offset: 0, size: 50 })
  })

  test("travels the track as the box scrolls to its end", () => {
    expect(thumbGeometry(375, 1000, 250, 200)).toEqual({ offset: 75, size: 50 })
    expect(thumbGeometry(750, 1000, 250, 200)).toEqual({ offset: 150, size: 50 })
  })

  test("keeps a grabbable thumb for long content", () => {
    expect(thumbGeometry(0, 100_000, 250, 200).size).toBe(MIN_THUMB_SIZE)
    expect(thumbGeometry(99_750, 100_000, 250, 200).offset).toBe(200 - MIN_THUMB_SIZE)
  })

  test("never outgrows a track shorter than the minimum", () => {
    expect(thumbGeometry(10, 1000, 250, 16)).toEqual({ offset: 0, size: 16 })
  })

  test("pins an elastic overscroll to the ends", () => {
    expect(thumbGeometry(-40, 1000, 250, 200).offset).toBe(0)
    expect(thumbGeometry(790, 1000, 250, 200).offset).toBe(150)
  })
})

describe("scrollPerThumbPixel", () => {
  test("maps the thumb's travel onto the scroll range", () => {
    expect(scrollPerThumbPixel(1000, 250, 200, 50)).toBe(5)
  })

  test("scrolls nothing when the thumb fills the track", () => {
    expect(scrollPerThumbPixel(1000, 250, 16, 16)).toBe(0)
  })
})
