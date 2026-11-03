import { describe, expect, test } from "bun:test"

import {
  MIN_THUMB_SIZE,
  scrollPerThumbPixel,
  thumbGeometry,
  trackPressScroll,
} from "./overlayScrollbars"

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

describe("trackPressScroll", () => {
  // 1000 of 2000 in view along a 1000px track: a 500px thumb, 2 per pixel.
  test("stops the thumb at a press nearer than a page", () => {
    expect(trackPressScroll(700, 0, 500, 875, 2)).toBe(400)
    expect(trackPressScroll(300, 500, 500, 875, 2)).toBe(-400)
  })

  // 1000 of 10,000 in view: a 100px thumb, 10 per pixel.
  test("pages toward a farther press", () => {
    expect(trackPressScroll(800, 0, 100, 875, 10)).toBe(875)
    expect(trackPressScroll(100, 500, 100, 875, 10)).toBe(-875)
  })

  test("scrolls nothing once the thumb has reached the press", () => {
    expect(trackPressScroll(600, 100, 500, 875, 2)).toBe(0)
  })
})
