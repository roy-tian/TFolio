import { describe, expect, test } from "bun:test"

import {
  activeBookmarkKey,
  activeFileOutlineTarget,
  fileFoldKey,
  foldableBookmarks,
  foldAllOf,
  foldsAfterBookmarkDelete,
  NO_FOLDS,
  toggledFold,
} from "./outlineFolds"
import type { FileRun } from "./pageSections"
import type { PdfOutlineItem, PdfSection } from "./pdf"

const item = (
  title: string,
  items: PdfOutlineItem[] = [],
  pageNumber: number | null = 1,
): PdfOutlineItem => ({
  items,
  pageNumber,
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

describe("activeBookmarkKey", () => {
  const tree = [
    item(
      "Part 1",
      [
        item("Chapter 1", [item("1.1", [], 2), item("1.2", [], 5)], 2),
        item("Chapter 2", [], 8),
      ],
      2,
    ),
    item("Appendix", [item("A", [], 12), item("B", [], 15)], null),
  ]

  test("returns null before the first bookmark", () => {
    expect(activeBookmarkKey(tree, "root", 1, NO_FOLDS)).toBeNull()
  })

  test("picks the deepest covering bookmark in document order", () => {
    expect(activeBookmarkKey(tree, "root", 2, NO_FOLDS)).toBe("root-0-0-0")
    expect(activeBookmarkKey(tree, "root", 4, NO_FOLDS)).toBe("root-0-0-0")
    expect(activeBookmarkKey(tree, "root", 5, NO_FOLDS)).toBe("root-0-0-1")
    expect(activeBookmarkKey(tree, "root", 10, NO_FOLDS)).toBe("root-0-1")
    expect(activeBookmarkKey(tree, "root", 14, NO_FOLDS)).toBe("root-1-0")
  })

  test("falls back to the outermost collapsed ancestor without unfolding", () => {
    expect(activeBookmarkKey(tree, "root", 6, new Set(["root-0-0"]))).toBe("root-0-0")
    expect(activeBookmarkKey(tree, "root", 6, new Set(["root-0", "root-0-0"]))).toBe("root-0")
    expect(activeBookmarkKey(tree, "root", 13, new Set(["root-1"]))).toBe("root-1")
  })

  test("does not let an out-of-order back-link hijack an earlier page", () => {
    const withBackLink = [
      item("Cover", [], 1),
      item("Chapter 1", [], 2),
      item("Back to cover", [], 1),
    ]

    expect(activeBookmarkKey(withBackLink, "root", 1, NO_FOLDS)).toBe("root-0")
    expect(activeBookmarkKey(withBackLink, "root", 2, NO_FOLDS)).toBe("root-1")
  })
})

describe("activeFileOutlineTarget", () => {
  const runs: FileRun[] = [
    { count: 3, first: 1, leads: true, ordinal: 0, section: 0 },
    { count: 4, first: 4, leads: true, ordinal: 0, section: 1 },
  ]
  const sections = new Map<number, PdfSection>([
    [0, { id: 0, outline: [], title: "cover.pdf" }],
    [
      1,
      {
        id: 1,
        outline: [item("Intro", [], 5), item("Body", [], 6)],
        title: "report.pdf",
      },
    ],
  ])

  test("targets the file row when it has no covering bookmark or is folded", () => {
    expect(activeFileOutlineTarget(runs, sections, 2, NO_FOLDS)).toEqual({
      kind: "file",
      key: "0:0",
    })
    expect(activeFileOutlineTarget(runs, sections, 4, NO_FOLDS)).toEqual({
      kind: "file",
      key: "1:0",
    })
    expect(
      activeFileOutlineTarget(runs, sections, 6, new Set([fileFoldKey(1)])),
    ).toEqual({
      kind: "file",
      key: "1:0",
    })
  })

  test("targets the covering bookmark when the file is open", () => {
    expect(activeFileOutlineTarget(runs, sections, 5, NO_FOLDS)).toEqual({
      kind: "bookmark",
      key: "section-1-0",
    })
    expect(activeFileOutlineTarget(runs, sections, 7, NO_FOLDS)).toEqual({
      kind: "bookmark",
      key: "section-1-1",
    })
  })
})

describe("foldsAfterBookmarkDelete", () => {
  test("drops the deleted bookmark and its descendants and shifts later siblings down", () => {
    const folds = new Set([
      "root-0",
      "root-1",
      "root-1-0",
      "root-2",
      "root-2-0",
      "root-10",
      "file-1",
    ])

    expect([...foldsAfterBookmarkDelete(folds, "root", 1)].sort()).toEqual([
      "file-1",
      "root-0",
      "root-1",
      "root-1-0",
      "root-9",
    ])
  })

  test("shifts nested siblings without touching their parent", () => {
    const folds = new Set(["root-0", "root-0-0", "root-0-1", "root-0-2-0", "root-1"])

    expect([...foldsAfterBookmarkDelete(folds, "root-0", 1)].sort()).toEqual([
      "root-0",
      "root-0-0",
      "root-0-1-0",
      "root-1",
    ])
  })
})
