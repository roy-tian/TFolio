import { describe, expect, test } from "bun:test"

import { classifyOpenSource, pdfNameFromSource } from "./openSources"

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
