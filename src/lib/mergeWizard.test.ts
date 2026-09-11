import { describe, expect, it } from "bun:test"

import {
  appendFiles,
  canMerge,
  hasExistingBookmarks,
  isMergeBookmarksMode,
  isMergeExportMode,
  isMergeImagePath,
  isMergeSourcePath,
  isMergeWordPath,
  MAX_MERGE_FILES,
  mergeLayout,
  mergedPageCount,
  mergesIntoOneDocument,
  mergeWizardSteps,
  moveFile,
  padPageCount,
  usableFiles,
  type MergeFile,
} from "@/lib/mergeWizard"

function file(name: string, pageCount: number | null, hasOutline = false): MergeFile {
  return {
    error: null,
    hasOutline,
    kind: "pdf",
    name: `${name}.pdf`,
    pageCount,
    path: `/tmp/${name}.pdf`,
  }
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
    expect(canMerge([file("a", 1)], "onePdf")).toBe(false)
    expect(canMerge([file("a", 1), file("broken", null)], "onePdf")).toBe(false)
    expect(canMerge([file("a", 1), file("b", 1)], "onePdf")).toBe(true)
    expect(canMerge([file("a", 1), file("b", 1)], "pagePngZip")).toBe(true)
  })

  it("takes a single file for the export that merges nothing", () => {
    expect(canMerge([file("a", 1)], "watermarkOnlyZip")).toBe(true)
    expect(canMerge([file("broken", null)], "watermarkOnlyZip")).toBe(false)
    expect(canMerge([], "watermarkOnlyZip")).toBe(false)
  })
})

describe("isMergeExportMode", () => {
  it("accepts the three modes and nothing else", () => {
    expect(isMergeExportMode("onePdf")).toBe(true)
    expect(isMergeExportMode("watermarkOnlyZip")).toBe(true)
    expect(isMergeExportMode("pageJpgZip")).toBe(false)
    expect(isMergeExportMode(null)).toBe(false)
  })
})

describe("mergeWizardSteps", () => {
  it("asks every step for a merge into one document", () => {
    expect(mergeWizardSteps("onePdf")).toEqual([
      "files",
      "bookmarks",
      "pageNumbers",
      "watermark",
    ])
  })

  it("leaves out the steps whose answer could not reach the result", () => {
    // A PNG carries no outline; copies that were never merged have neither an
    // outline to build nor a page sequence to number.
    expect(mergeWizardSteps("pagePngZip")).toEqual([
      "files",
      "pageNumbers",
      "watermark",
    ])
    expect(mergeWizardSteps("watermarkOnlyZip")).toEqual(["files", "watermark"])
  })

  it("knows which modes make one page sequence out of the files", () => {
    expect(mergesIntoOneDocument("onePdf")).toBe(true)
    expect(mergesIntoOneDocument("pagePngZip")).toBe(true)
    expect(mergesIntoOneDocument("watermarkOnlyZip")).toBe(false)
  })
})

describe("isMergeWordPath", () => {
  it("matches both Word extensions, however they are cased", () => {
    expect(isMergeWordPath("/tmp/letter.docx")).toBe(true)
    expect(isMergeWordPath("/tmp/old.DOC")).toBe(true)
    expect(isMergeWordPath("/tmp/letter.docx.bak")).toBe(false)
    expect(isMergeWordPath("/tmp/docx")).toBe(false)
  })
})

describe("isMergeSourcePath", () => {
  it("takes Word documents only while the reader's setting allows it", () => {
    expect(isMergeSourcePath("/tmp/letter.docx")).toBe(true)
    expect(isMergeSourcePath("/tmp/letter.docx", false)).toBe(false)
    // Everything else is untouched by the setting.
    expect(isMergeSourcePath("/tmp/report.pdf", false)).toBe(true)
    expect(isMergeSourcePath("/tmp/scan.png", false)).toBe(true)
  })

  it("takes PDFs and the image formats a merge can lay on a page", () => {
    expect(isMergeSourcePath("/tmp/report.pdf")).toBe(true)
    expect(isMergeSourcePath("/tmp/scan.JPG")).toBe(true)
    expect(isMergeSourcePath("C:\\Files\\photo.webp")).toBe(true)
    expect(isMergeSourcePath("/tmp/notes.txt")).toBe(false)
    expect(isMergeSourcePath("/tmp/png")).toBe(false)
  })

  it("tells an image apart from a PDF", () => {
    expect(isMergeImagePath("/tmp/scan.tiff")).toBe(true)
    expect(isMergeImagePath("/tmp/report.pdf")).toBe(false)
  })
})
