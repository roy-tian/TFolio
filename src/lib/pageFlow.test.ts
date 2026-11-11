import { describe, expect, test } from "bun:test"

import { flowItems } from "./pageFlow"
import type { PdfPageInfo } from "./pdf"

const page = (section?: number) => ({ height: 792, rotation: 0, section, width: 612 }) as PdfPageInfo
const NONE: ReadonlySet<number> = new Set()
const identity = (count: number) => Array.from({ length: count }, (_, index) => index + 1)

describe("flowItems", () => {
  // Two pages of file 0, three of file 1, one more of file 0.
  const pages = [page(0), page(0), page(1), page(1), page(1), page(0)]

  test("heads each run of a file's pages with its name", () => {
    expect(
      flowItems({ breakAt: null, byFile: true, folded: NONE, held: NONE, order: identity(6), pages }),
    ).toEqual([
      { heads: 0, index: 0, kind: "page", pageNumber: 1 },
      { heads: undefined, index: 1, kind: "page", pageNumber: 2 },
      { heads: 1, index: 2, kind: "page", pageNumber: 3 },
      { heads: undefined, index: 3, kind: "page", pageNumber: 4 },
      { heads: undefined, index: 4, kind: "page", pageNumber: 5 },
      { heads: 0, index: 5, kind: "page", pageNumber: 6 },
    ])
  })

  test("names no file, and folds none, while the files run together", () => {
    const items = flowItems({
      breakAt: null,
      byFile: false,
      folded: new Set([1]),
      held: NONE,
      order: identity(6),
      pages,
    })

    expect(items.every((item) => item.kind === "page" && item.heads === undefined)).toBe(true)
  })

  test("stands a folded file's run as one bar, one per run", () => {
    expect(
      flowItems({
        breakAt: null,
        byFile: true,
        folded: new Set([0]),
        held: NONE,
        order: identity(6),
        pages,
      }),
    ).toEqual([
      { held: false, index: 0, kind: "bar", pages: [1, 2], section: 0 },
      { heads: 1, index: 2, kind: "page", pageNumber: 3 },
      { heads: undefined, index: 3, kind: "page", pageNumber: 4 },
      { heads: undefined, index: 4, kind: "page", pageNumber: 5 },
      { held: false, index: 5, kind: "bar", pages: [6], section: 0 },
    ])
  })

  test("carries a folded file in hand as one bar where it would land", () => {
    // File 0, folded, held whole and let go in front of file 1's last page.
    const items = flowItems({
      breakAt: null,
      byFile: true,
      folded: new Set([0]),
      held: new Set([1, 2, 6]),
      order: [3, 4, 1, 2, 6, 5],
      pages,
    })

    expect(items).toEqual([
      { heads: 1, index: 0, kind: "page", pageNumber: 3 },
      { heads: undefined, index: 1, kind: "page", pageNumber: 4 },
      { held: true, index: 2, kind: "bar", pages: [1, 2, 6], section: 0 },
      // Still under its own name: pages in hand head nothing.
      { heads: undefined, index: 5, kind: "page", pageNumber: 5 },
    ])
  })

  test("keeps pages in hand out of the bar they were folded under", () => {
    const items = flowItems({
      breakAt: null,
      byFile: true,
      folded: new Set([1]),
      held: new Set([4]),
      order: [1, 4, 2, 3, 5, 6],
      pages,
    })

    expect(items.map((item) => (item.kind === "bar" ? item.pages : item.pageNumber))).toEqual([
      1,
      [4],
      2,
      [3, 5],
      6,
    ])
  })

  test("ends a bar where pages from elsewhere would land", () => {
    const items = flowItems({
      breakAt: 3,
      byFile: true,
      folded: new Set([1]),
      held: NONE,
      order: identity(6),
      pages,
    })

    expect(items.map((item) => (item.kind === "bar" ? item.pages : item.pageNumber))).toEqual([
      1,
      2,
      [3],
      [4, 5],
      6,
    ])
  })
})
