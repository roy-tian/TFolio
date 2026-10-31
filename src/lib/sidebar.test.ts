import { describe, expect, test } from "bun:test"

import {
  isSidebarPanel,
  shownSidebarPanel,
  sidebarDockMinWidth,
  sidebarMode,
} from "./sidebar"

describe("isSidebarPanel", () => {
  test("accepts the two panels and nothing a hand edit might leave", () => {
    expect(isSidebarPanel("bookmarks")).toBe(true)
    expect(isSidebarPanel("thumbnails")).toBe(true)
    expect(isSidebarPanel("Bookmarks")).toBe(false)
    expect(isSidebarPanel(undefined)).toBe(false)
  })
})

describe("shownSidebarPanel", () => {
  test("falls back to the pages without bookmarks, keeping the choice", () => {
    expect(shownSidebarPanel("bookmarks", false)).toBe("thumbnails")
    expect(shownSidebarPanel("bookmarks", true)).toBe("bookmarks")
    expect(shownSidebarPanel("thumbnails", true)).toBe("thumbnails")
  })
})

describe("sidebarMode", () => {
  test("docks while there is room, by the reader's choice", () => {
    expect(sidebarMode(true, true, false)).toBe("docked")
    expect(sidebarMode(false, true, false)).toBe("hidden")
  })

  test("only peeks over the pages in a narrow window, whatever was chosen", () => {
    expect(sidebarMode(true, false, false)).toBe("hidden")
    expect(sidebarMode(false, false, true)).toBe("overlay")
  })

  test("docks wider on platforms whose toolbar carries the window buttons", () => {
    expect(sidebarDockMinWidth(false)).toBeGreaterThan(sidebarDockMinWidth(true))
  })
})
