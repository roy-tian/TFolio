import { describe, expect, test } from "bun:test"

import {
  activeTabAfterClose,
  selectOpenedTabId,
  tabIdForKey,
  tabIdForPath,
} from "./documentTabs"

describe("document tabs", () => {
  test("finds only an exact duplicate path", () => {
    const tabs = [
      { id: 1, path: "/docs/a.pdf" },
      { id: 2, path: "/docs/A.pdf" },
    ]

    expect(tabIdForPath(tabs, "/docs/a.pdf")).toBe(1)
    expect(tabIdForPath(tabs, "/docs/./a.pdf")).toBeNull()
  })

  test("activates only a batch-opened tab that is still open", () => {
    expect(selectOpenedTabId([1, 2, 3], [2, 3], "first")).toBe(2)
    expect(selectOpenedTabId([1, 2, 3], [1, 2], "last")).toBe(2)
    expect(selectOpenedTabId([1, 2], [3], "last")).toBeNull()
  })

  test("closing the active tab selects its next neighbour, then its previous", () => {
    expect(activeTabAfterClose([1, 2, 3], 2, 2)).toBe(3)
    expect(activeTabAfterClose([1, 2, 3], 3, 3)).toBe(2)
    expect(activeTabAfterClose([1], 1, 1)).toBeNull()
    expect(activeTabAfterClose([1, 2], 1, 2)).toBe(1)
  })

  test("keyboard navigation wraps and supports the ends", () => {
    const ids = [4, 7, 9]

    expect(tabIdForKey(ids, 4, "ArrowLeft")).toBe(9)
    expect(tabIdForKey(ids, 9, "ArrowRight")).toBe(4)
    expect(tabIdForKey(ids, 7, "Home")).toBe(4)
    expect(tabIdForKey(ids, 7, "End")).toBe(9)
    expect(tabIdForKey(ids, 7, "Enter")).toBeNull()
  })
})
