import { describe, expect, test } from "bun:test"

import {
  classifyOpenSource,
  isImagePath,
  isSourcePath,
  isWordPath,
  pdfNameFromSource,
} from "./openSources"

describe("open sources", () => {
  test("classifies by extension on either platform's separator", () => {
    expect(classifyOpenSource("/home/roy/docs/report.pdf")).toBe("pdf")
    expect(classifyOpenSource("C:\\Users\\roy\\photo.PNG")).toBe("image")
    expect(classifyOpenSource("/tmp/report.DocX")).toBe("word")
    expect(classifyOpenSource("/tmp/scan.webp")).toBe("image")
    expect(classifyOpenSource("/tmp/no-extension")).toBeNull()
    expect(classifyOpenSource("/tmp/archive.zip")).toBeNull()
  })

  test("names a converted source's export after its PDF form", () => {
    expect(pdfNameFromSource("/home/roy/report.docx")).toBe("report.pdf")
    expect(pdfNameFromSource("C:\\Users\\roy\\photo.png")).toBe("photo.pdf")
    expect(pdfNameFromSource("/tmp/no-extension")).toBe("no-extension.pdf")
  })
})

describe("isWordPath", () => {
  test("matches both Word extensions, however they are cased", () => {
    expect(isWordPath("/tmp/letter.docx")).toBe(true)
    expect(isWordPath("/tmp/old.DOC")).toBe(true)
    expect(isWordPath("/tmp/letter.docx.bak")).toBe(false)
    expect(isWordPath("/tmp/docx")).toBe(false)
  })
})

describe("isSourcePath", () => {
  test("takes Word documents only while a converter is there", () => {
    expect(isSourcePath("/tmp/letter.docx")).toBe(true)
    expect(isSourcePath("/tmp/letter.docx", false)).toBe(false)
    expect(isSourcePath("/tmp/report.pdf", false)).toBe(true)
    expect(isSourcePath("/tmp/scan.png", false)).toBe(true)
  })

  test("takes PDFs and the image formats a page can be made of", () => {
    expect(isSourcePath("/tmp/report.pdf")).toBe(true)
    expect(isSourcePath("/tmp/scan.JPG")).toBe(true)
    expect(isSourcePath("C:\\Files\\photo.webp")).toBe(true)
    expect(isSourcePath("/tmp/notes.txt")).toBe(false)
    expect(isSourcePath("/tmp/png")).toBe(false)
  })

  test("tells an image apart from a PDF", () => {
    expect(isImagePath("/tmp/scan.tiff")).toBe(true)
    expect(isImagePath("/tmp/report.pdf")).toBe(false)
  })
})
