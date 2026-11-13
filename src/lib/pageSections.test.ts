import { describe, expect, test } from "bun:test"

import {
  emptiesItsFile,
  fileMoveOrder,
  fileRuns,
  foldedAway,
  reorderSections,
  sectionAt,
  sectionsOf,
} from "./pageSections"

const page = (section?: number) => ({ height: 842, rotation: 0, section, width: 595 })

describe("sectionsOf", () => {
  test("names each position's file, or nothing for a file alone", () => {
    expect(sectionsOf([page(0), page(1), page(1)])).toEqual([0, 1, 1])
    expect(sectionsOf([page(), page()])).toBeNull()
  })
})

describe("sectionAt", () => {
  const pages = [page(0), page(0), page(1)]

  test("joins the file of the page it goes in front of", () => {
    expect(sectionAt(pages, 1)).toBe(0)
    expect(sectionAt(pages, 3)).toBe(1)
  })

  test("joins the last page's file at the very end", () => {
    expect(sectionAt(pages, 4)).toBe(1)
    expect(sectionAt([], 1)).toBeUndefined()
  })
})

describe("reorderSections", () => {
  const pages = [page(0), page(0), page(1), page(1)]

  test("takes the moved pages into the file they were dropped among", () => {
    // Page 1 dropped between the second file's pages.
    expect(reorderSections(pages, [2, 3, 1, 4], new Set([1]), 1)).toEqual({
      after: [0, 1, 1, 1],
      before: [0, 0, 1, 1],
    })
  })

  test("has nothing to lay out without files or a file to join", () => {
    expect(reorderSections([page(), page()], [2, 1], new Set([1]), 0)).toBeUndefined()
    expect(reorderSections(pages, [2, 1, 3, 4], new Set([1]), undefined)).toBeUndefined()
  })
})

describe("fileMoveOrder", () => {
  const filed = (...sections: number[]) =>
    sections.map((section) => ({ height: 1, rotation: 0, section, width: 1 }))

  test("moves a file whole in front of a page of another", () => {
    expect(fileMoveOrder(filed(0, 0, 1, 2, 2), 2, 3)).toEqual([1, 2, 4, 5, 3])
    expect(fileMoveOrder(filed(0, 0, 1, 2, 2), 0, null)).toEqual([3, 4, 5, 1, 2])
  })

  test("gathers a file split into runs", () => {
    expect(fileMoveOrder(filed(0, 1, 0, 2), 0, 4)).toEqual([2, 1, 3, 4])
    // In front of its own second run: where that run stands among the others.
    expect(fileMoveOrder(filed(0, 1, 0, 2), 0, 3)).toEqual([2, 1, 3, 4])
  })

  test("moves nothing where the file already stands", () => {
    expect(fileMoveOrder(filed(0, 1, 2), 1, 3)).toBeNull()
    expect(fileMoveOrder(filed(0, 1, 2), 2, null)).toBeNull()
    expect(fileMoveOrder(filed(0, 1), 5, null)).toBeNull()
  })
})

describe("fileRuns", () => {
  test("lists each stretch of a file's pages, the file's first one leading", () => {
    expect(fileRuns([page(0), page(1), page(1), page(0)])).toEqual([
      { count: 1, first: 1, leads: true, ordinal: 0, section: 0 },
      { count: 2, first: 2, leads: true, ordinal: 0, section: 1 },
      { count: 1, first: 4, leads: false, ordinal: 1, section: 0 },
    ])
  })

  test("has none for a document still its own file alone", () => {
    expect(fileRuns([page(), page()])).toEqual([])
  })
})

describe("emptiesItsFile", () => {
  const filed = (...sections: number[]) =>
    sections.map((section) => ({ height: 1, rotation: 0, section, width: 1 }))

  test("holds when the pages are all their file has", () => {
    expect(emptiesItsFile(filed(0, 1, 1), [1])).toBe(true)
    expect(emptiesItsFile(filed(0, 0, 1), [2])).toBe(false)
    expect(emptiesItsFile([page(), page()], [1, 2])).toBe(false)
  })
})

describe("foldedAway", () => {
  const pages = [page(0), page(1), page(1)]

  test("holds for a page of a folded file, while names head the files' pages", () => {
    expect(foldedAway(pages, 2, new Set([1]), true)).toBe(true)
    expect(foldedAway(pages, 1, new Set([1]), true)).toBe(false)
    // The files run together: nothing is folded, whatever was before.
    expect(foldedAway(pages, 2, new Set([1]), false)).toBe(false)
    expect(foldedAway([page(), page()], 1, new Set([0]), true)).toBe(false)
  })
})
