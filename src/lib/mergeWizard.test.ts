import { describe, expect, it } from "bun:test"

import {
  appendFiles,
  canMerge,
  hasExistingBookmarks,
  isMergeBookmarksMode,
  MAX_MERGE_FILES,
  mergeLayout,
  mergedPageCount,
  moveFile,
  padPageCount,
  usableFiles,
  type MergeFile,
} from "@/lib/mergeWizard"

function file(name: string, pageCount: number | null, hasOutline = false): MergeFile {
  return { hasOutline, name: `${name}.pdf`, pageCount, path: `/tmp/${name}.pdf` }
}

describe("isMergeBookmarksMode", () => {
  it("accepts the four modes and nothing else", () => {
    expect(isMergeBookmarksMode("perFileWithExisting")).toBe(true)
    expect(isMergeBookmarksMode("none")).toBe(true)
    expect(isMergeBookmarksMode("perDocument")).toBe(false)
    expect(isMergeBookmarksMode(null)).toBe(false)
  })
})

describe("mergeLayout", () => {
  it("lays the files end to end when nothing is padded", () => {
    const { placements, totalPages } = mergeLayout(
      [file("a", 2), file("b", 3), file("c", 1)],
      false,
    )

    expect(placements.map((placement) => placement.startsAt)).toEqual([1, 3, 6])
    expect(placements.every((placement) => !placement.padded)).toBe(true)
    expect(totalPages).toBe(6)
  })

  it("pads only the files that would otherwise open on an even page", () => {
    const { placements, totalPages } = mergeLayout(
      [file("a", 1), file("b", 1), file("c", 2)],
      true,
    )

    // A pad before the second file bumps it from page 2 to 3; the third then
    // falls on page 4, so it takes one too.
    expect(placements.map((placement) => placement.startsAt)).toEqual([1, 3, 5])
    expect(placements.map((placement) => placement.padded)).toEqual([
      false,
      true,
      true,
    ])
    expect(totalPages).toBe(6)
  })

  it("leaves a file that already opens on an odd page alone", () => {
    const { placements } = mergeLayout([file("a", 2), file("b", 4)], true)

    expect(placements.map((placement) => placement.padded)).toEqual([false, false])
  })

  it("skips the files the backend could not read", () => {
    const files = [file("a", 2), file("broken", null), file("b", 1)]

    expect(usableFiles(files)).toHaveLength(2)
    expect(mergedPageCount(files, false)).toBe(3)
    expect(mergeLayout(files, false).placements.map((one) => one.startsAt)).toEqual([
      1, 3,
    ])
  })
})

describe("padPageCount", () => {
  it("counts the blanks the switch would add", () => {
    const files = [file("a", 1), file("b", 1), file("c", 1)]

    expect(padPageCount(files, true)).toBe(2)
    expect(padPageCount(files, false)).toBe(0)
  })
})

describe("hasExistingBookmarks", () => {
  it("is true only when a usable file brings its own", () => {
    expect(hasExistingBookmarks([file("a", 2), file("b", 1, true)])).toBe(true)
    expect(hasExistingBookmarks([file("a", 2), file("b", 1)])).toBe(false)
    // An unreadable file's bookmarks are not going anywhere.
    expect(hasExistingBookmarks([file("broken", null, true)])).toBe(false)
  })
})

describe("appendFiles", () => {
  it("adds to the end and drops paths already on the list", () => {
    const existing = [file("a", 1), file("b", 1)]
    const next = appendFiles(existing, [file("b", 1), file("c", 1)])

    expect(next.files.map((one) => one.name)).toEqual([
      "a.pdf",
      "b.pdf",
      "c.pdf",
    ])
    expect(next.dropped).toBe(0)
  })

  it("drops a repeat inside one batch too", () => {
    expect(appendFiles([], [file("a", 1), file("a", 1)]).files).toHaveLength(1)
  })

  it("stops at the ceiling and says how many it turned away", () => {
    const many = Array.from({ length: MAX_MERGE_FILES + 3 }, (_, index) =>
      file(`f${index}`, 1),
    )
    const next = appendFiles([], many)

    expect(next.files).toHaveLength(MAX_MERGE_FILES)
    expect(next.dropped).toBe(3)
  })
})

describe("moveFile", () => {
  const files = [file("a", 1), file("b", 1), file("c", 1)]

  it("moves a file to its new place", () => {
    expect(moveFile(files, 2, 0).map((one) => one.name)).toEqual([
      "c.pdf",
      "a.pdf",
      "b.pdf",
    ])
  })

  it("leaves the order alone for a move that goes nowhere", () => {
    expect(moveFile(files, 1, 1)).toBe(files)
    expect(moveFile(files, 0, -1)).toBe(files)
    expect(moveFile(files, 0, 3)).toBe(files)
  })
})

describe("canMerge", () => {
  it("needs two files the backend can actually read", () => {
    expect(canMerge([file("a", 1)])).toBe(false)
    expect(canMerge([file("a", 1), file("broken", null)])).toBe(false)
    expect(canMerge([file("a", 1), file("b", 1)])).toBe(true)
  })
})
