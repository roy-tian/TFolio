import { describe, expect, it } from "bun:test"

import { pagesToRotate, turnView } from "@/lib/pageRotation"

const selected = (...pages: number[]) => new Set(pages)

describe("turnView", () => {
  it("turns a reading view a quarter further", () => {
    expect(turnView(0)).toBe(90)
    expect(turnView(180)).toBe(270)
  })

  it("wraps a full turn back to upright", () => {
    expect(turnView(270)).toBe(0)
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
