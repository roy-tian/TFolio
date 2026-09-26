import { describe, expect, it } from "bun:test"

import {
  cachedPageText,
  forgetDocumentText,
  rememberPageText,
} from "@/lib/pageText"

const span = (text: string) => ({
  height: 10,
  left: 0,
  text,
  top: 0,
  width: 10,
})

describe("page text cache", () => {
  it("answers only for the same document, page and text epoch", () => {
    rememberPageText(1, 2, 0, [span("before")])

    expect(cachedPageText(1, 2, 0)).toEqual([span("before")])
    expect(cachedPageText(1, 2, 1)).toBeUndefined()
    expect(cachedPageText(1, 3, 0)).toBeUndefined()
    expect(cachedPageText(2, 2, 0)).toBeUndefined()
  })

  it("forgets a document that leaves", () => {
    rememberPageText(7, 1, 0, [span("kept")])
    rememberPageText(70, 1, 0, [span("other")])
    forgetDocumentText(7)

    expect(cachedPageText(7, 1, 0)).toBeUndefined()
    expect(cachedPageText(70, 1, 0)).toEqual([span("other")])
  })

  it("evicts the page read longest ago", () => {
    for (let page = 1; page <= 200; page += 1) {
      rememberPageText(9, page, 0, [span(`page ${page}`)])
    }

    // Read again, so page 1 is no longer the oldest.
    cachedPageText(9, 1, 0)
    rememberPageText(9, 201, 0, [span("page 201")])

    expect(cachedPageText(9, 1, 0)).toBeDefined()
    expect(cachedPageText(9, 2, 0)).toBeUndefined()
  })
})
