import { describe, expect, test } from "bun:test"

import {
  activeTabAfterClose,
  HOME_TAB_ID,
  reorderedTabs,
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

  test("a strip drag moves a tab forward and backward", () => {
    expect(reorderedTabs(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"])
    expect(reorderedTabs(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"])
  })

  test("a strip drag that lands nowhere changes nothing", () => {
    const tabs = ["a", "b", "c"]

    expect(reorderedTabs(tabs, 1, 1)).toBe(tabs)
    expect(reorderedTabs(tabs, -1, 0)).toBe(tabs)
    expect(reorderedTabs(tabs, 0, 3)).toBe(tabs)
    expect(reorderedTabs([], 0, 0)).toEqual([])
  })
})
