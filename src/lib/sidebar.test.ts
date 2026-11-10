import { describe, expect, test } from "bun:test"

import {
  clampSidebarWidth,
  isSidebarPanel,
  shownSidebarPanel,
  SIDEBAR_MIN_WIDTH,
  sidebarDockMinWidth,
  sidebarMode,
  sidebarReservedWidth,
  sidebarWidthOf,
  thumbnailColumns,
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

describe("sidebar width", () => {
  test("reads any number, rounded and no narrower than the sidebar opens", () => {
    expect(sidebarWidthOf(420.4)).toBe(420)
    expect(sidebarWidthOf(12)).toBe(SIDEBAR_MIN_WIDTH)
    expect(sidebarWidthOf("wide")).toBeNull()
    expect(sidebarWidthOf(Number.NaN)).toBeNull()
    expect(sidebarWidthOf(undefined)).toBeNull()
  })

  test("leaves the docked toolbar the room it has in the narrowest docked window", () => {
    const reserved = sidebarReservedWidth(false, true)

    expect(reserved).toBe(sidebarDockMinWidth(false) - SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(900, 1280, reserved)).toBe(1280 - reserved)
    expect(clampSidebarWidth(300, 1280, reserved)).toBe(300)
    // At the docking threshold the sidebar can only be as wide as it opens.
    expect(clampSidebarWidth(600, sidebarDockMinWidth(false), reserved)).toBe(
      SIDEBAR_MIN_WIDTH,
    )
  })

  test("never narrows below its opening width, however small the window", () => {
    expect(clampSidebarWidth(100, 500, sidebarReservedWidth(true, false))).toBe(
      SIDEBAR_MIN_WIDTH,
    )
    expect(clampSidebarWidth(900, 700, sidebarReservedWidth(true, false))).toBe(636)
  })
})

describe("thumbnailColumns", () => {
  test("stays one column at the opening width and adds one per cell of room", () => {
    // 16rem less the column's own padding.
    expect(thumbnailColumns(240, 160)).toBe(1)
    expect(thumbnailColumns(331, 160)).toBe(1)
    expect(thumbnailColumns(332, 160)).toBe(2)
    expect(thumbnailColumns(504, 160)).toBe(3)
    expect(thumbnailColumns(0, 160)).toBe(1)
  })
})
