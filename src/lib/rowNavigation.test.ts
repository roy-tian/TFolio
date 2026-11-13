import { describe, expect, test } from "bun:test"

import { stepInRows } from "./rowNavigation"

const rows = [["auto"], ["a", "b", "c"], ["d", "e"], ["f", "g", "h"]]

describe("stepInRows", () => {
  test.each([
    ["a", "ArrowRight", "b"],
    ["c", "ArrowRight", "d"],
    ["d", "ArrowLeft", "c"],
    ["a", "ArrowLeft", "auto"],
    ["auto", "ArrowDown", "a"],
    ["b", "ArrowUp", "auto"],
    ["b", "ArrowDown", "e"],
    ["c", "ArrowDown", "e"],
    ["e", "ArrowDown", "g"],
    ["e", "ArrowUp", "b"],
    ["g", "Home", "auto"],
    ["a", "End", "h"],
  ])("from %s, %s leads to %s", (current, key, expected) => {
    expect(stepInRows(rows, current, key)).toBe(expected)
  })

  test.each([
    ["auto", "ArrowLeft"],
    ["auto", "ArrowUp"],
    ["auto", "Home"],
    ["h", "ArrowRight"],
    ["g", "ArrowDown"],
    ["h", "End"],
    ["b", "Enter"],
    ["missing", "ArrowDown"],
  ])("from %s, %s moves nothing", (current, key) => {
    expect(stepInRows(rows, current, key)).toBeNull()
  })
})
