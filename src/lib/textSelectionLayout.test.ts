import { describe, expect, it } from "bun:test"

import { nearestTextLine, nearestTextRun, textLines } from "@/lib/textSelectionLayout"

const rect = (left: number, top: number, width = 8, height = 10) => ({ left, top, width, height })

describe("text selection layout", () => {
  it("uses a whole visual row through gaps and different glyph heights", () => {
    const runs = [rect(0, 0), rect(12, 4, 5, 6), rect(24, 1, 8, 9), rect(0, 25), rect(12, 29, 5, 6)]
    const lines = textLines(runs)
    expect(lines).toHaveLength(2)
    expect(lines[1].runs).toEqual([3, 4])
    for (let x = 0; x < 32; x++) {
      expect(nearestTextLine(lines, x, 26)).toBe(lines[1])
    }
    expect(nearestTextRun(lines[1], runs, 11)).toBe(4)
  })

  it("does not jump to the longer next row when extending into a margin", () => {
    const lines = textLines([rect(0, 0, 30), rect(0, 16, 200)])
    expect(nearestTextLine(lines, 180, 5, lines[0])).toBe(lines[0])
    expect(nearestTextLine(lines, 180, 20, lines[0])).toBe(lines[1])
  })

  it("never jumps backward when dragging below a short final line", () => {
    const lines = textLines([rect(0, 0, 400), rect(0, 20, 30)])
    let previous = lines[1]
    for (const y of [29, 30, 30.1, 31, 100, 30, 25]) {
      previous = nearestTextLine(lines, 200, y, previous)!
      expect(previous).toBe(lines[1])
    }
    expect(nearestTextLine(lines, 200, 5, previous)).toBe(lines[0])
    expect(nearestTextLine(lines, 200, 30.1)).toBe(lines[1])
  })

  it("keeps table cells and columns separate", () => {
    const lines = textLines([
      rect(0, 0, 30), rect(90, 0, 30),
      rect(0, 20, 30), rect(90, 20, 30),
    ])
    expect(lines).toHaveLength(4)
    expect(nearestTextLine(lines, 100, 4)?.runs).toEqual([1])
    expect(nearestTextLine(lines, 100, 24)?.runs).toEqual([3])
    expect(nearestTextLine(lines, 10, 24)?.runs).toEqual([2])
    // Moving into a different cell on the same row must not be sticky.
    expect(nearestTextLine(lines, 100, 4, lines[0])?.runs).toEqual([1])
  })

  it("does not let a tall heading absorb neighboring column lines", () => {
    const lines = textLines([rect(0, 0, 60, 34), rect(200, 0, 80), rect(200, 14, 70)])
    expect(lines).toHaveLength(3)
    expect(nearestTextLine(lines, 205, 5)?.runs).toEqual([1])
    expect(nearestTextLine(lines, 205, 18)?.runs).toEqual([2])
    // Even in the leading, the other column's tall heading is not a target.
    expect(nearestTextLine(lines, 205, 11, lines[1])?.runs).toEqual([1])
    expect(nearestTextLine(lines, 205, 13, lines[1])?.runs).toEqual([2])
  })

  it("leaves a heading across both columns for the column under the pointer", () => {
    const lines = textLines([
      rect(0, 0, 300, 14),
      rect(0, 30, 120), rect(180, 30, 120),
      rect(0, 45, 120), rect(180, 52, 120),
    ])
    const heading = lines[0]
    const right = lines.filter(line => line.left === 180)
    expect(lines).toHaveLength(5)
    // Between the right column's lines, level with the left column's ink.
    expect(nearestTextLine(lines, 200, 47, heading)).toBe(right[1])
    expect(nearestTextLine(lines, 200, 47)).toBe(right[1])
  })

  it("keeps a short final line when an indented block further down sits under x", () => {
    const lines = textLines([rect(0, 0, 400), rect(0, 20, 30), rect(60, 80, 300)])
    for (const y of [26, 31, 40]) {
      expect(nearestTextLine(lines, 200, y, lines[1])).toBe(lines[1])
    }
  })

  it("never offers a line whose runs an overlapping line took", () => {
    const lines = textLines([rect(0, 0, 100), rect(0, 20, 100)])
    const empty = { ...rect(0, 40, 100), runs: [] }
    expect(nearestTextLine([...lines, empty], 50, 45)).toBe(lines[1])
    expect(nearestTextLine([...lines, empty], 50, 45, lines[1])).toBe(lines[1])
  })

  it("sorts fragmented runs spatially without changing their text indices", () => {
    const lines = textLines([rect(24, 0), rect(0, 0), rect(12, 0)])
    expect(lines[0].runs).toEqual([1, 2, 0])
  })

  it("assigns every glyph once on a densely fragmented page", () => {
    const runs = Array.from({ length: 40_000 }, (_, index) =>
      rect((index % 80) * 6, Math.floor(index / 80) * 12, 5),
    )
    const lines = textLines(runs)
    expect(lines).toHaveLength(500)
    expect(lines.every(line => line.runs.length === 80)).toBe(true)
    expect(new Set(lines.flatMap(line => line.runs)).size).toBe(runs.length)
  })

  it("accepts empty and singleton pages", () => {
    expect(nearestTextLine(textLines([]), 0, 0)).toBeUndefined()
    const runs = [rect(20, 30)]
    const lines = textLines(runs)
    expect(nearestTextRun(lines[0], runs, 200)).toBe(0)
  })
})
