import { describe, expect, it } from "bun:test"

import { insertIndexForHit } from "@/lib/fileDrop"

describe("insertIndexForHit", () => {
  it("takes a gap's own position", () => {
    expect(insertIndexForHit({ kind: "gap", index: 3 }, 500)).toBe(3)
  })

  it("puts the file before the page whose left half the pointer is in", () => {
    const page = { kind: "page", left: 100, pageNumber: 4, width: 160 } as const

    expect(insertIndexForHit(page, 140)).toBe(4)
  })

  it("puts it after the page whose right half the pointer is in", () => {
    const page = { kind: "page", left: 100, pageNumber: 4, width: 160 } as const

    expect(insertIndexForHit(page, 220)).toBe(5)
  })

  it("has no target where the pointer is over neither", () => {
    expect(insertIndexForHit(null, 220)).toBeNull()
  })
})
