import { describe, expect, test } from "bun:test"

import { isPdfFile } from "./pdf"

describe("isPdfFile", () => {
  test("accepts the PDF MIME type", () => {
    expect(isPdfFile({ name: "document", type: "application/pdf" })).toBe(true)
  })

  test("accepts a PDF extension when the OS omits the MIME type", () => {
    expect(isPdfFile({ name: "document.PDF", type: "" })).toBe(true)
  })

  test("rejects other file types", () => {
    expect(isPdfFile({ name: "notes.txt", type: "text/plain" })).toBe(false)
  })
})
