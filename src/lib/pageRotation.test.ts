import { describe, expect, it } from "bun:test"

import {
  pagesToRotate,
  rotationForPage,
  rotationsAfterRotate,
  rotationsForPageCount,
} from "@/lib/pageRotation"

const selected = (...pages: number[]) => new Set(pages)

describe("rotationsAfterRotate", () => {
  it("turns every page of a reading view a quarter further", () => {
    expect(rotationsAfterRotate([0, 90, 180])).toEqual([90, 180, 270])
  })

  it("wraps a full turn back to upright", () => {
    expect(rotationsAfterRotate([270])).toEqual([0])
  })
})

describe("pagesToRotate", () => {
  it("turns only the selected pages", () => {
    expect(pagesToRotate(4, selected(2, 4))).toEqual([2, 4])
  })

  it("turns the whole document when nothing is selected", () => {
    expect(pagesToRotate(3, selected())).toEqual([1, 2, 3])
  })

  it("reads a complete selection as the same whole document", () => {
    expect(pagesToRotate(3, selected(1, 2, 3))).toEqual([1, 2, 3])
  })

  it("leaves out a selected page the document no longer has", () => {
    expect(pagesToRotate(2, selected(2, 5))).toEqual([2])
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
