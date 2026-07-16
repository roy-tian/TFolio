import { describe, expect, test } from "bun:test"

import { dimensionsForRotation, isPdfFile, pickCurrentPage } from "./pdf"

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

describe("pickCurrentPage", () => {
  // A 700px-tall viewer, in the client coordinates the tracker reads off.
  const VIEWPORT_TOP = 0
  const VIEWPORT_BOTTOM = 700

  const page = (pageNumber: number, top: number, bottom: number) => ({
    bottom,
    pageNumber,
    top,
  })
  const pick = (candidates: ReturnType<typeof page>[]) =>
    pickCurrentPage(candidates, VIEWPORT_TOP, VIEWPORT_BOTTOM)

  test("returns null when nothing is visible", () => {
    expect(pick([])).toBeNull()
  })

  // The regression a fixed reading line caused: landscape thumbnail rows are
  // 107px tall, so a line sitting ~237px down landed two rows past the one
  // navigation had just parked at the top.
  test("reports a short row parked at the top of the viewer", () => {
    const rows = [page(13, 20, 127), page(17, 165, 272), page(21, 310, 417)]

    expect(pick(rows)).toBe(13)
  })

  test("holds the top row until it is more than half gone", () => {
    // 57 of 107 left, so still the reader's row.
    expect(pick([page(1, -50, 57), page(5, 73, 180)])).toBe(1)
    // 47 of 107 left, so the row below takes over.
    expect(pick([page(1, -60, 47), page(5, 63, 170)])).toBe(5)
  })

  test("scores a page taller than the viewport against the viewport", () => {
    // Nothing can show more than 700px, so filling the viewer counts as whole.
    expect(pick([page(3, -100, 1100)])).toBe(3)
  })

  test("hands over as the next tall page takes the viewport", () => {
    expect(pick([page(5, -800, 400), page(6, 420, 1620)])).toBe(5)
    expect(pick([page(5, -1000, 200), page(6, 220, 1420)])).toBe(6)
  })

  test("falls back to the most visible page when neither clears half", () => {
    // The gap between two tall pages leaves both just under the bar.
    expect(pick([page(5, -865, 335), page(6, 355, 1555)])).toBe(6)
  })

  // A book spread and a thumbnail row put several pages on the same line.
  test("resolves a tie to the lowest page number, whatever the order", () => {
    const spread = [page(4, 0, 300), page(3, 0, 300)]

    expect(pick(spread)).toBe(3)
    expect(pick([...spread].reverse())).toBe(3)
  })
})
