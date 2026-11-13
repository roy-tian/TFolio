import { describe, expect, test } from "bun:test"

import {
  classifyOpenSource,
  isImagePath,
  isWordPath,
  partitionOpenable,
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

describe("partitionOpenable", () => {
  test("takes PDFs, images and Word documents, in the order given", () => {
    expect(
      partitionOpenable([
        "/tmp/report.pdf",
        "/tmp/notes.txt",
        "C:\\Files\\photo.webp",
        "/tmp/letter.DOCX",
        "/tmp/png",
      ]),
    ).toEqual({
      openable: ["/tmp/report.pdf", "C:\\Files\\photo.webp", "/tmp/letter.DOCX"],
      skipped: ["/tmp/notes.txt", "/tmp/png"],
    })
  })

  test("tells an image apart from a PDF", () => {
    expect(isImagePath("/tmp/scan.tiff")).toBe(true)
    expect(isImagePath("/tmp/report.pdf")).toBe(false)
  })
})
