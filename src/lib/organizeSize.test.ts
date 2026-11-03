import { describe, expect, test } from "bun:test"

import { ORGANIZE_PAPER_WIDTHS, organizeStepOf } from "./organizeSize"

describe("organizeStepOf", () => {
  test("finds the step each stored size names", () => {
    ORGANIZE_PAPER_WIDTHS.forEach((width, step) => {
      expect(organizeStepOf(width)).toBe(step)
    })
  })

  test("falls back to the second size for anything a hand edit might leave", () => {
    expect(organizeStepOf(undefined)).toBe(1)
    expect(organizeStepOf(180)).toBe(1)
    expect(organizeStepOf("200")).toBe(1)
    expect(organizeStepOf(2)).toBe(1)
  })
})
