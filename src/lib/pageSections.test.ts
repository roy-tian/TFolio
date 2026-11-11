import { describe, expect, test } from "bun:test"

import {
  emptiesItsFile,
  fileEndIndex,
  fileMoveOrder,
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

  test("moves a file whole in front of another", () => {
    expect(fileMoveOrder(filed(0, 0, 1, 2, 2), 2, 1)).toEqual([1, 2, 4, 5, 3])
    expect(fileMoveOrder(filed(0, 0, 1, 2, 2), 0, null)).toEqual([3, 4, 5, 1, 2])
  })

  test("gathers a file split into runs", () => {
    expect(fileMoveOrder(filed(0, 1, 0, 2), 0, 2)).toEqual([2, 1, 3, 4])
  })

  test("moves nothing where the file already stands", () => {
    expect(fileMoveOrder(filed(0, 1, 2), 1, 2)).toBeNull()
    expect(fileMoveOrder(filed(0, 1, 2), 2, null)).toBeNull()
    expect(fileMoveOrder(filed(0, 1), 5, null)).toBeNull()
  })
})

describe("fileEndIndex", () => {
  const pages = [page(0), page(1), page(0), page(1)]

  test("goes before a file's first page or after its last, wherever its pages stand", () => {
    expect(fileEndIndex(pages, 1, "start")).toBe(2)
    expect(fileEndIndex(pages, 1, "end")).toBe(5)
    expect(fileEndIndex(pages, 0, "end")).toBe(4)
  })

  test("has nowhere to go in a file with no page", () => {
    expect(fileEndIndex(pages, 2, "start")).toBeNull()
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
