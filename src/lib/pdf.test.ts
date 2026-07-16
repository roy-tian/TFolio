import { describe, expect, test } from "bun:test"

import { dimensionsForRotation, isPdfFile, pickNearestPage } from "./pdf"

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

describe("dimensionsForRotation", () => {
  test("leaves upright pages alone", () => {
    expect(dimensionsForRotation(0, 200, 300)).toEqual({ height: 300, width: 200 })
    expect(dimensionsForRotation(180, 200, 300)).toEqual({ height: 300, width: 200 })
  })

  test("swaps the axes on a quarter turn", () => {
    expect(dimensionsForRotation(90, 200, 300)).toEqual({ height: 200, width: 300 })
    expect(dimensionsForRotation(270, 200, 300)).toEqual({ height: 200, width: 300 })
  })
})

describe("pickNearestPage", () => {
  const page = (pageNumber: number, top: number, bottom: number) => ({
    bottom,
    pageNumber,
    top,
  })

  test("returns null when nothing is visible", () => {
    expect(pickNearestPage([], 100)).toBeNull()
  })

  test("prefers the page spanning the reading line", () => {
    const candidates = [page(1, -500, -100), page(2, -50, 400)]

    expect(pickNearestPage(candidates, 0)).toBe(2)
  })

  test("falls back to the closest page when the line sits in a gap", () => {
    const candidates = [page(1, -300, -80), page(2, 40, 500)]

    expect(pickNearestPage(candidates, 0)).toBe(2)
  })

  // A book spread and a thumbnail row put several pages on the same line.
  test("resolves a tie to the lowest page number", () => {
    const candidates = [page(4, 0, 300), page(3, 0, 300)]

    expect(pickNearestPage(candidates, 150)).toBe(3)
  })

  test("resolves a tie by page number, not by visibility order", () => {
    const candidates = [page(6, 0, 300), page(5, 0, 300)]

    expect(pickNearestPage(candidates.reverse(), 150)).toBe(5)
  })
})
