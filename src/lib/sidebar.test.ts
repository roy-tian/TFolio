import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import {
  clampSidebarWidth,
  DOCKED_PAGES_MIN_WIDTH,
  isSidebarPanel,
  SIDEBAR_DOCK_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
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

describe("sidebarMode", () => {
  test("docks while there is room, by the reader's choice", () => {
    expect(sidebarMode(true, true, false)).toBe("docked")
    expect(sidebarMode(false, true, false)).toBe("hidden")
  })

  test("only peeks over the pages in a narrow window, whatever was chosen", () => {
    expect(sidebarMode(true, false, false)).toBe("hidden")
    expect(sidebarMode(false, false, true)).toBe("overlay")
  })

  test("docks only where the pages keep the room the narrowest window gives them", () => {
    for (const config of ["tauri.conf.json", "tauri.macos.conf.json"]) {
      const { minWidth } = JSON.parse(
        readFileSync(new URL(`../../src-tauri/${config}`, import.meta.url), "utf8"),
      ).app.windows[0] as { minWidth: number }

      expect(minWidth).toBe(DOCKED_PAGES_MIN_WIDTH)
    }

    expect(SIDEBAR_DOCK_MIN_WIDTH).toBe(SIDEBAR_MIN_WIDTH + DOCKED_PAGES_MIN_WIDTH)
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

  test("leaves the docked pages the room they have in the narrowest docked window", () => {
    const reserved = sidebarReservedWidth(true)

    expect(reserved).toBe(SIDEBAR_DOCK_MIN_WIDTH - SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(900, 1280, reserved)).toBe(1280 - reserved)
    expect(clampSidebarWidth(300, 1280, reserved)).toBe(300)
    // At the docking threshold the sidebar can only be as wide as it opens.
    expect(clampSidebarWidth(600, SIDEBAR_DOCK_MIN_WIDTH, reserved)).toBe(
      SIDEBAR_MIN_WIDTH,
    )
  })

  test("never narrows below its opening width, however small the window", () => {
    expect(clampSidebarWidth(100, 500, sidebarReservedWidth(false))).toBe(
      SIDEBAR_MIN_WIDTH,
    )
    expect(clampSidebarWidth(900, 700, sidebarReservedWidth(false))).toBe(636)
  })
})

describe("thumbnailColumns", () => {
  test("adds a column per cell and gap of room, and keeps at least one", () => {
    // The sidebar as it opens, less the column's own padding.
    expect(thumbnailColumns(208, 160)).toBe(1)
    expect(thumbnailColumns(343, 160)).toBe(1)
    expect(thumbnailColumns(344, 160)).toBe(2)
    expect(thumbnailColumns(527, 160)).toBe(2)
    expect(thumbnailColumns(528, 160)).toBe(3)
    expect(thumbnailColumns(0, 160)).toBe(1)
  })
})
