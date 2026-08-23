import { describe, expect, test } from "bun:test"

import {
  activeTabAfterClose,
  HOME_TAB_ID,
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
    const ids = [HOME_TAB_ID, 1, 2, 3]

    expect(activeTabAfterClose(ids, 2, 2)).toBe(3)
    expect(activeTabAfterClose(ids, 3, 3)).toBe(2)
    expect(activeTabAfterClose(ids, 1, 2)).toBe(1)
  })

  test("closing the last document falls back to home", () => {
    expect(activeTabAfterClose([HOME_TAB_ID, 1], 1, 1)).toBe(HOME_TAB_ID)
  })

  test("keyboard navigation wraps through home and supports the ends", () => {
    const ids = [HOME_TAB_ID, 4, 7, 9]

    expect(tabIdForKey(ids, HOME_TAB_ID, "ArrowLeft")).toBe(9)
    expect(tabIdForKey(ids, 9, "ArrowRight")).toBe(HOME_TAB_ID)
    expect(tabIdForKey(ids, 7, "Home")).toBe(HOME_TAB_ID)
    expect(tabIdForKey(ids, 7, "End")).toBe(9)
    expect(tabIdForKey(ids, 7, "Enter")).toBeNull()
  })
})
