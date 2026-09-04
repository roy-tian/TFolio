import { describe, expect, it } from "bun:test"

import {
  rotationForPage,
  rotationsAfterRotate,
  rotationsForPageCount,
} from "@/lib/pageRotation"

const selected = (...pages: number[]) => new Set(pages)

describe("rotationsAfterRotate", () => {
  it("rotates every page in the single and book views", () => {
    expect(rotationsAfterRotate([0, 90, 180], "single", selected(2))).toEqual([
      90,
      180,
      270,
    ])
    expect(rotationsAfterRotate([0, 90, 180], "book", selected(2))).toEqual([
      90,
      180,
      270,
    ])
  })

  it("rotates only selected pages in the thumbnail view", () => {
    expect(
      rotationsAfterRotate([0, 0, 0, 0], "thumbnail", selected(2, 4)),
    ).toEqual([0, 90, 0, 90])
  })

  it("rotates every thumbnail when none or all are selected", () => {
    expect(
      rotationsAfterRotate([0, 90, 180], "thumbnail", selected()),
    ).toEqual([90, 180, 270])
    expect(
      rotationsAfterRotate([0, 90, 180], "thumbnail", selected(1, 2, 3)),
    ).toEqual([90, 180, 270])
  })

  it("wraps a full turn back to upright", () => {
    expect(rotationsAfterRotate([270], "thumbnail", selected(1))).toEqual([0])
  })
})

describe("page rotation lookup", () => {
  it("falls back to upright outside the current page list", () => {
    expect(rotationForPage([90], 1)).toBe(90)
    expect(rotationForPage([90], 2)).toBe(0)
  })

  it("trims removed positions and initializes added positions upright", () => {
    expect(rotationsForPageCount([90, 180, 270], 2)).toEqual([90, 180])
    expect(rotationsForPageCount([90], 3)).toEqual([90, 0, 0])
  })
})
