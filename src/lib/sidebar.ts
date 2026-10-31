import { rememberSettings, storedSettings } from "@/lib/settings"

export const sidebarPanels = ["bookmarks", "thumbnails"] as const

export type SidebarPanel = (typeof sidebarPanels)[number]

/** How the sidebar sits in the window: beside the pages, over them in a window
    too narrow to give it room, or gone. */
export type SidebarMode = "docked" | "overlay" | "hidden"

export const defaultSidebarPanel: SidebarPanel = "thumbnails"

/**
 * The narrowest window that docks the sidebar: 16rem plus the toolbar beside
 * it, measured at 804px with the window buttons and a four-digit page count
 * (2026-10-31), and some room for wider system fonts. macOS has no window
 * buttons of its own to fit.
 */
export function sidebarDockMinWidth(macOS: boolean) {
  return macOS ? 980 : 1100
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

/** A document without bookmarks keeps the reader's choice standing, so the
    next document that has some opens on them again. */
export function shownSidebarPanel(
  preferred: SidebarPanel,
  bookmarksApply: boolean,
): SidebarPanel {
  return preferred === "bookmarks" && !bookmarksApply ? "thumbnails" : preferred
}

export function sidebarMode(open: boolean, docked: boolean, peeking: boolean): SidebarMode {
  if (docked) {
    return open ? "docked" : "hidden"
  }

  return peeking ? "overlay" : "hidden"
}
