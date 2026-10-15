import { describe, expect, it } from "bun:test"

import type { PdfPageInfo } from "@/lib/pdf"
import { selectedLineRectsOnPage } from "@/lib/textSelection"
import { registerPageRuns } from "@/lib/textSelectionPage"

const page: PdfPageInfo = { height: 100, rotation: 0, width: 100 }
const runs = [
  { height: 10, left: 10, top: 10, width: 30 },
  { height: 10, left: 45, top: 10, width: 30 },
  // PDFium's width can carry a run past the page's edge.
  { height: 10, left: 90, top: 40, width: 20 },
]

function selection(whole: boolean) {
  return {
    containsNode: (_node: Node, partly: boolean) => partly || whole,
  } as unknown as Selection
}

describe("a page selected whole before its spans are built", () => {
  it("is every line its extracted runs give, clipped to the page", () => {
    const element = {} as Element
    const release = registerPageRuns(element, runs)
    try {
      expect(selectedLineRectsOnPage(selection(true), element, page, 0)).toEqual([
        { height: 10, left: 10, top: 10, width: 65 },
        { height: 10, left: 90, top: 40, width: 10 },
      ])
    } finally {
      release()
    }
  })

  it("is nothing while a selection only reaches into it, or its runs are not in", () => {
    const element = {} as Element
    expect(selectedLineRectsOnPage(selection(true), element, page, 0)).toEqual([])

    const release = registerPageRuns(element, runs)
    try {
      expect(selectedLineRectsOnPage(selection(false), element, page, 0)).toEqual([])
    } finally {
      release()
    }
  })
})
