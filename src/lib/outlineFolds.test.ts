import { describe, expect, test } from "bun:test"

import { foldableBookmarks, foldAllOf, NO_FOLDS, toggledFold } from "./outlineFolds"
import type { PdfOutlineItem } from "./pdf"

const item = (title: string, items: PdfOutlineItem[] = []): PdfOutlineItem => ({
  items,
  pageNumber: 1,
  title,
})

const outline = [
  item("One", [item("1.1", [item("1.1.1")]), item("1.2")]),
  item("Two"),
  item("Three", [item("3.1")]),
]

describe("foldableBookmarks", () => {
  test("lists every bookmark with others under it, at every depth", () => {
    expect(foldableBookmarks(outline, "root")).toEqual(["root-0", "root-0-0", "root-2"])
  })

  test("a flat outline has none", () => {
    expect(foldableBookmarks([item("A"), item("B")], "root")).toEqual([])
  })
})

describe("toggledFold", () => {
  test("folds an open key and opens a folded one", () => {
    const folded = toggledFold(NO_FOLDS, "root-0")

    expect([...folded]).toEqual(["root-0"])
    expect([...toggledFold(folded, "root-0")]).toEqual([])
  })
})

describe("foldAllOf", () => {
  const all = foldableBookmarks(outline, "root")
  const top = ["root-0", "root-2"]

  test("folds every level, then has nothing left to fold", () => {
    const open = foldAllOf(NO_FOLDS, top, all)

    expect(open.canFold).toBe(true)
    expect(open.canUnfold).toBe(false)

    const folded = open.fold(true)

    expect([...folded].sort()).toEqual(all)
    expect(foldAllOf(folded, top, all).canFold).toBe(false)
    expect(foldAllOf(folded, top, all).canUnfold).toBe(true)
  })

  test("offers both while only some are folded", () => {
    const some = foldAllOf(new Set(["root-0"]), top, all)

    expect(some.canFold).toBe(true)
    expect(some.canUnfold).toBe(true)
    // The first level folded, an open one beneath it is out of sight.
    expect(foldAllOf(new Set(["root-0", "root-2"]), top, all).canFold).toBe(false)
    // Folded deeper alone, it still has something to unfold.
    expect(foldAllOf(new Set(["root-0-0"]), top, all).canUnfold).toBe(true)
  })

  test("unfolds only its own keys", () => {
    const folds = new Set(["root-0", "root-0-0", "file-3"])

    expect([...foldAllOf(folds, top, all).fold(false)]).toEqual(["file-3"])
    expect(foldAllOf(new Set(["file-3"]), top, all).canUnfold).toBe(false)
  })

  test("is off where nothing folds", () => {
    const flat = foldAllOf(NO_FOLDS, [], [])

    expect(flat.canFold).toBe(false)
    expect(flat.canUnfold).toBe(false)
  })
})
