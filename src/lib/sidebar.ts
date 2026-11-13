import type { CSSProperties } from "react"

import { rememberSettings, storedSettings } from "@/lib/settings"

export const sidebarPanels = ["bookmarks", "thumbnails"] as const

export type SidebarPanel = (typeof sidebarPanels)[number]

/** How the sidebar sits in the window: beside the pages, over them in a window
    too narrow to give it room, or gone. */
export type SidebarMode = "docked" | "overlay" | "hidden"

export const defaultSidebarPanel: SidebarPanel = "thumbnails"

/** 16rem at the default font size: the sidebar as it opens, and as narrow as
    it goes. */
export const SIDEBAR_MIN_WIDTH = 256

/** The narrowest the pages get beside a docked sidebar: the window's own
    `minWidth` (tauri.conf.json), so docking never leaves them less room than a
    window can have. The toolbar's words fold where they no longer fit. */
export const DOCKED_PAGES_MIN_WIDTH = 640

/** The narrowest window that docks the sidebar. */
export const SIDEBAR_DOCK_MIN_WIDTH = SIDEBAR_MIN_WIDTH + DOCKED_PAGES_MIN_WIDTH

/** One arrow press on the sidebar's edge. */
export const SIDEBAR_WIDTH_STEP = 16

// An overlay keeps this much of the pages in view: a press there sends it away.
const OVERLAY_PAGES_MARGIN = 64

/** How much of the window the sidebar may not take: docked, the pages keep the
    room they have at the narrowest docked window. */
export function sidebarReservedWidth(docked: boolean) {
  return docked ? DOCKED_PAGES_MIN_WIDTH : OVERLAY_PAGES_MARGIN
}

/** The width a drag or an arrow press settles on in a window this wide. */
export function clampSidebarWidth(width: number, windowWidth: number, reserved: number) {
  const limit = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(windowWidth - reserved))

  return Math.min(limit, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

/** The window clamps it again as it resizes, in CSS, so a hand-edited width
    need only be a number. */
export function sidebarWidthOf(stored: unknown): number | null {
  return typeof stored === "number" && Number.isFinite(stored)
    ? Math.max(SIDEBAR_MIN_WIDTH, Math.round(stored))
    : null
}

/** The gap between the previews of a sidebar wide enough for several
    columns, which also holds a blank's way in. */
export const THUMBNAIL_GRID_GAP = 24

/** The gap down a sidebar's one column of previews. */
export const THUMBNAIL_COLUMN_GAP = 12

/** How many fixed-size previews fit across the sidebar's content box. */
export function thumbnailColumns(contentWidth: number, cell: number) {
  return Math.max(1, Math.floor((contentWidth + THUMBNAIL_GRID_GAP) / (cell + THUMBNAIL_GRID_GAP)))
}

/** The workspace root's custom properties for a chosen width; `index.css`
    clamps it to the window. */
export function sidebarWidthStyle(width: number | null, reserved: number) {
  return width === null
    ? undefined
    : ({
        "--sidebar-chosen": `${width}px`,
        "--sidebar-reserved": `${reserved}px`,
      } as CSSProperties)
}

export function readStoredSidebarWidth() {
  return sidebarWidthOf(storedSettings().ui?.sidebarWidth)
}

/** Null is the width the sidebar opens with, which the file then leaves out. */
export function storeSidebarWidth(width: number | null) {
  if (sidebarWidthOf(storedSettings().ui?.sidebarWidth) !== width) {
    void rememberSettings({ ui: { sidebarWidth: width ?? undefined } })
  }
}

/** A document of several files shows each on rows of its own until the
    reader runs them together. */
export function readStoredFileRows() {
  return storedSettings().ui?.sidebarFileRows !== false
}

export function storeFileRows(fileRows: boolean) {
  void rememberSettings({ ui: { sidebarFileRows: fileRows } })
}

export function isSidebarPanel(value: unknown): value is SidebarPanel {
  return sidebarPanels.includes(value as SidebarPanel)
}

/** Shown unless the reader hid it: the sidebar is how pages are found. */
export function readStoredSidebarOpen() {
  return storedSettings().ui?.sidebar !== "hidden"
}

export function readStoredSidebarPanel(): SidebarPanel {
  const stored = storedSettings().ui?.sidebarPanel

  return isSidebarPanel(stored) ? stored : defaultSidebarPanel
}

export function storeSidebarOpen(open: boolean) {
  void rememberSettings({ ui: { sidebar: open ? "shown" : "hidden" } })
}

export function storeSidebarPanel(panel: SidebarPanel) {
  void rememberSettings({ ui: { sidebarPanel: panel } })
}

export function sidebarMode(open: boolean, docked: boolean, peeking: boolean): SidebarMode {
  if (docked) {
    return open ? "docked" : "hidden"
  }

  return peeking ? "overlay" : "hidden"
}
