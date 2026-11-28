import { invoke } from "@tauri-apps/api/core"
import type { TFunction } from "i18next"

import type { AnnotationTool } from "@/components/AnnotationToolbar"
import { fileNameFromPath } from "@/lib/pdf"
import { isMacOS } from "@/lib/platform"
import type { RecentFile } from "@/lib/recentFiles"
import type { ViewMode } from "@/lib/viewMode"

export const MENU_ACTION_EVENT = "menu://action"

export type NativeContextMenuItem =
  | {
      /** A choice among several, shown with AppKit's checkmark when true. */
      checked?: boolean
      enabled?: boolean
      id: string
      kind: "item"
      label: string
    }
  | {
      kind: "separator"
    }

/** A popup's top-left corner in CSS pixels from the window's top-left. */
export type NativeMenuPoint = {
  x: number
  y: number
}

/** Where a dropdown's menu opens: under its trigger, as a pull-down button's. */
export function nativeMenuPointBelow(trigger: Element): NativeMenuPoint {
  const rect = trigger.getBoundingClientRect()

  return { x: rect.left, y: rect.bottom + 4 }
}

export type MacMenuStaticLabels = {
  aboutApp: string
  addFiles: string
  appHelp: string
  appName: string
  book: string
  checkUpdates: string
  closeAll: string
  closeTab: string
  closeWindow: string
  compress: string
  copy: string
  cut: string
  edit: string
  enterFullScreen: string
  eraser: string
  exportImages: string
  file: string
  find: string
  fitA4: string
  help: string
  hideApp: string
  hideOthers: string
  highlight: string
  maximize: string
  minimize: string
  newDoc: string
  newWindow: string
  open: string
  openRecent: string
  pageNumbers: string
  paste: string
  quitApp: string
  recentEmpty: string
  rect: string
  save: string
  saveAll: string
  saveAs: string
  selectAll: string
  services: string
  settings: string
  showAll: string
  singlePage: string
  split: string
  textNote: string
  tools: string
  view: string
  watermark: string
  window: string
  zoomFitPage: string
  zoomFitWidth: string
  zoomIn: string
  zoomOut: string
  zoomReset: string
}

export type MacMenuDynamicLabels = {
  redo: string
  toggleSidebar: string
  undo: string
}

export type RecentMenuEntry = Pick<RecentFile, "name" | "path">

export type MacMenuFlags = {
  activeTool: AnnotationTool
  bookApplies: boolean
  canCloseAll: boolean
  canRedo: boolean
  canSave: boolean
  canSaveAll: boolean
  canUndo: boolean
  hasDocument: boolean
  saveAsOnly: boolean
  typingTarget: boolean
  viewMode: ViewMode | null
  zoomCanIn: boolean
  zoomCanOut: boolean
}

export type MacMenuSnapshot = {
  dynamicLabels: MacMenuDynamicLabels
  flags: MacMenuFlags
  recentFiles: RecentMenuEntry[]
  staticLabels: MacMenuStaticLabels
}

export type MenuActionPayload = {
  id: string
  path?: string
}

export type DocumentMenuState = {
  activeTool: AnnotationTool
  bookApplies: boolean
  canRedo: boolean
  canSave: boolean
  canUndo: boolean
  redoLabel: string
  saveAsOnly: boolean
  undoLabel: string
  viewMode: ViewMode
  zoomCanIn: boolean
  zoomCanOut: boolean
}

export function buildMacMenuStaticLabels(t: TFunction): MacMenuStaticLabels {
  const appName = t("app.documentTitle")

  return {
    aboutApp: t("menu.aboutApp", { app: appName }),
    addFiles: t("menu.addFiles"),
    appHelp: t("menu.appHelp", { app: appName }),
    appName,
    book: t("statusBar.viewModeBook"),
    checkUpdates: t("menu.checkUpdates"),
    closeAll: t("menu.closeAll"),
    closeTab: t("menu.closeTab"),
    closeWindow: t("menu.closeWindow"),
    compress: t("compressExport.menuLabel"),
    copy: t("menu.copy"),
    cut: t("menu.cut"),
    edit: t("menu.edit"),
    enterFullScreen: t("menu.enterFullScreen"),
    eraser: t("annotate.eraser"),
    exportImages: t("imageExport.menuLabel"),
    file: t("menu.file"),
    find: t("menu.find"),
    fitA4: t("a4Export.menuLabel"),
    help: t("menu.help"),
    hideApp: t("menu.hideApp", { app: appName }),
    hideOthers: t("menu.hideOthers"),
    highlight: t("annotate.highlight"),
    maximize: t("window.maximize"),
    minimize: t("window.minimize"),
    newDoc: t("menu.new"),
    newWindow: t("menu.newWindow"),
    open: t("menu.openFile"),
    openRecent: t("menu.openRecent"),
    pageNumbers: t("menu.pageNumbersMenu"),
    paste: t("menu.paste"),
    quitApp: t("menu.quitApp", { app: appName }),
    recentEmpty: t("menu.recentEmpty"),
    rect: t("annotate.rect"),
    save: t("annotate.save"),
    saveAll: t("menu.saveAll"),
    saveAs: t("menu.saveAs"),
    selectAll: t("menu.selectAll"),
    services: t("menu.services"),
    settings: t("menu.settingsEllipsis"),
    showAll: t("menu.showAll"),
    singlePage: t("statusBar.viewModeSingle"),
    split: t("splitExport.menuLabel"),
    textNote: t("annotate.textNote"),
    tools: t("menu.tools"),
    view: t("menu.view"),
    watermark: t("menu.watermarkMenu"),
    window: t("menu.window"),
    zoomFitPage: t("statusBar.zoomFitPage"),
    zoomFitWidth: t("statusBar.zoomFitWidth"),
    zoomIn: t("statusBar.zoomIn"),
    zoomOut: t("statusBar.zoomOut"),
    zoomReset: t("statusBar.zoomReset"),
  }
}

/**
 * Builds up to `limit` native recent-file menu entries, appending the folder
 * name when multiple entries share a filename (using the full directory path if
 * their leaf folders also match).
 */
export function formatRecentMenuEntries(
  files: readonly RecentFile[],
  limit: number,
): RecentMenuEntry[] {
  const limited = files.slice(0, Math.max(0, limit))
  const nameCounts = new Map<string, number>()

  for (const file of limited) {
    nameCounts.set(file.name, (nameCounts.get(file.name) ?? 0) + 1)
  }

  const leafKeyCounts = new Map<string, number>()
  for (const file of limited) {
    if ((nameCounts.get(file.name) ?? 0) <= 1) {
      continue
    }
    const leaf = fileNameFromPath(file.directory) || file.directory
    const key = `${file.name}\0${leaf}`
    leafKeyCounts.set(key, (leafKeyCounts.get(key) ?? 0) + 1)
  }

  return limited.map((file) => {
    if ((nameCounts.get(file.name) ?? 0) <= 1) {
      return { name: file.name, path: file.path }
    }

    const leaf = fileNameFromPath(file.directory) || file.directory
    const key = `${file.name}\0${leaf}`
    const folder =
      (leafKeyCounts.get(key) ?? 0) > 1 ? file.directory || leaf : leaf

    return {
      name: folder ? `${file.name} — ${folder}` : file.name,
      path: file.path,
    }
  })
}

export async function syncMacMenu(snapshot: MacMenuSnapshot, seq: number): Promise<void> {
  if (!isMacOS()) {
    return
  }

  await invoke("sync_macos_menu", { seq, snapshot })
}

/** Pops up AppKit's menu at `at`, or at the pointer without one. */
export async function popupNativeContextMenu(
  items: NativeContextMenuItem[],
  at?: NativeMenuPoint,
): Promise<string | null> {
  if (!isMacOS() || items.length === 0) {
    return null
  }

  return invoke<string | null>("popup_context_menu", { at: at ?? null, items })
}
