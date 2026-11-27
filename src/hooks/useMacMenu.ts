import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { useTranslation } from "react-i18next"

import type { DocumentSessionHandle } from "@/components/DocumentSession"
import type { SettingsSection } from "@/components/SettingsDialog"
import { hasLayerOverWorkspace, isTypingTarget } from "@/lib/contextMenu"
import { HOME_TAB_ID, type TabId } from "@/lib/documentTabs"
import {
  buildMacMenuStaticLabels,
  formatRecentMenuEntries,
  MENU_ACTION_EVENT,
  syncMacMenu,
  type DocumentMenuState,
  type MacMenuSnapshot,
  type MenuActionPayload,
} from "@/lib/nativeMenu"
import type { RecentFile } from "@/lib/recentFiles"

const RECENT_MENU_LIMIT = 10
const MAX_SYNC_RETRIES = 2
const SYNC_RETRY_DELAY_MS = 500

type UseMacMenuOptions = {
  activeId: TabId
  activeSession: () => DocumentSessionHandle | undefined
  canCloseAll: boolean
  canSaveAll: boolean
  documentState: DocumentMenuState | null
  enabled: boolean
  onCloseAll: () => void
  onCloseTab: (documentId: number) => void
  onNew: () => void
  onNewWindow: () => void
  onOpen: () => void
  onOpenRecent: (path: string) => void
  onRefreshRecent: () => void
  onSaveAll: () => void
  onShowSettings: (section: SettingsSection, options?: { recheck?: boolean }) => void
  onToggleSidebar: () => void
  recentFiles: RecentFile[]
  sidebarShown: boolean
}

export function useMacMenu({
  activeId,
  activeSession,
  canCloseAll,
  canSaveAll,
  documentState,
  enabled,
  onCloseAll,
  onCloseTab,
  onNew,
  onNewWindow,
  onOpen,
  onOpenRecent,
  onRefreshRecent,
  onSaveAll,
  onShowSettings,
  onToggleSidebar,
  recentFiles,
  sidebarShown,
}: UseMacMenuOptions) {
  const { i18n, t } = useTranslation()
  const [typingTarget, setTypingTarget] = useState(() =>
    enabled ? isTypingTarget(document.activeElement) : false,
  )
  const syncedSerializedRef = useRef("")
  const latestSerializedRef = useRef("")
  const syncSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      return
    }

    const syncTyping = () => setTypingTarget(isTypingTarget(document.activeElement))
    syncTyping()
    document.addEventListener("focusin", syncTyping, true)
    document.addEventListener("focusout", syncTyping, true)

    return () => {
      document.removeEventListener("focusin", syncTyping, true)
      document.removeEventListener("focusout", syncTyping, true)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const refresh = () => onRefreshRecent()
    window.addEventListener("focus", refresh)

    return () => window.removeEventListener("focus", refresh)
  }, [enabled, onRefreshRecent])

  const staticLabels = useMemo(
    () => buildMacMenuStaticLabels(t),
    // `i18n.resolvedLanguage` tracks language updates even if `t` stays stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.resolvedLanguage, t],
  )

  const hasDocument = activeId !== HOME_TAB_ID

  const snapshot = useMemo<MacMenuSnapshot | null>(() => {
    if (!enabled) {
      return null
    }

    return {
      dynamicLabels: {
        redo: documentState?.redoLabel ?? t("annotate.redo"),
        toggleSidebar: sidebarShown ? t("sidebar.hide") : t("sidebar.show"),
        undo: documentState?.undoLabel ?? t("annotate.undo"),
      },
      flags: {
        activeTool: documentState?.activeTool ?? null,
        bookApplies: documentState?.bookApplies ?? false,
        canCloseAll,
        canRedo: documentState?.canRedo ?? false,
        canSave: documentState?.canSave ?? false,
        canSaveAll,
        canUndo: documentState?.canUndo ?? false,
        hasDocument,
        saveAsOnly: documentState?.saveAsOnly ?? false,
        typingTarget,
        viewMode: documentState?.viewMode ?? null,
        zoomCanIn: documentState?.zoomCanIn ?? false,
        zoomCanOut: documentState?.zoomCanOut ?? false,
      },
      recentFiles: formatRecentMenuEntries(recentFiles, RECENT_MENU_LIMIT),
      staticLabels,
    }
  }, [
    canCloseAll,
    canSaveAll,
    documentState,
    enabled,
    hasDocument,
    recentFiles,
    sidebarShown,
    staticLabels,
    t,
    typingTarget,
  ])

  useEffect(() => {
    if (!snapshot) {
      latestSerializedRef.current = ""
      syncedSerializedRef.current = ""
      return
    }

    const serialized = JSON.stringify(snapshot)
    if (serialized === syncedSerializedRef.current && serialized === latestSerializedRef.current) {
      return
    }

    latestSerializedRef.current = serialized
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const sendSnapshot = (attempt: number) => {
      if (cancelled || latestSerializedRef.current !== serialized) {
        return
      }

      const attemptSeq = ++syncSeqRef.current
      void syncMacMenu(snapshot, attemptSeq)
        .then(() => {
          if (!cancelled && latestSerializedRef.current === serialized) {
            syncedSerializedRef.current = serialized
          }
        })
        .catch((error: unknown) => {
          if (cancelled || latestSerializedRef.current !== serialized) {
            return
          }

          if (attempt < MAX_SYNC_RETRIES) {
            retryTimer = setTimeout(() => {
              sendSnapshot(attempt + 1)
            }, SYNC_RETRY_DELAY_MS)
            return
          }

          console.warn("macOS menu sync failed:", error)
        })
    }

    sendSnapshot(0)

    return () => {
      cancelled = true
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
      }
    }
  }, [snapshot])

  const handlersRef = useRef({
    activeId,
    activeSession,
    onCloseAll,
    onCloseTab,
    onNew,
    onNewWindow,
    onOpen,
    onOpenRecent,
    onSaveAll,
    onShowSettings,
    onToggleSidebar,
  })
  useLayoutEffect(() => {
    handlersRef.current = {
      activeId,
      activeSession,
      onCloseAll,
      onCloseTab,
      onNew,
      onNewWindow,
      onOpen,
      onOpenRecent,
      onSaveAll,
      onShowSettings,
      onToggleSidebar,
    }
  })

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    let unlisten: (() => void) | undefined
    const label = getCurrentWindow().label

    void listen<MenuActionPayload>(
      MENU_ACTION_EVENT,
      (event) => {
        const { id, path } = event.payload
        const handlers = handlersRef.current

        switch (id) {
          case "app-about":
            handlers.onShowSettings("about")
            return
          case "app-check-updates":
            handlers.onShowSettings("about", { recheck: true })
            return
          case "app-settings":
            handlers.onShowSettings("appearance")
            return
          case "edit-undo":
            if (isTypingTarget(document.activeElement)) {
              document.execCommand("undo")
            } else if (!hasLayerOverWorkspace()) {
              handlers.activeSession()?.undo()
            }
            return
          case "edit-redo":
            if (isTypingTarget(document.activeElement)) {
              document.execCommand("redo")
            } else if (!hasLayerOverWorkspace()) {
              handlers.activeSession()?.redo()
            }
            return
          case "edit-select-all": {
            const active = document.activeElement
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
              active.select()
            } else if (isTypingTarget(active)) {
              document.execCommand("selectAll")
            } else if (!hasLayerOverWorkspace()) {
              requestAnimationFrame(() => window.getSelection()?.removeAllRanges())
              if (handlers.activeId !== HOME_TAB_ID) {
                handlers.activeSession()?.selectAll()
              }
            }
            return
          }
          default:
            break
        }

        if (hasLayerOverWorkspace()) {
          return
        }

        switch (id) {
          case "file-new":
            handlers.onNew()
            return
          case "file-new-window":
            handlers.onNewWindow()
            return
          case "file-open":
            handlers.onOpen()
            return
          case "file-open-recent":
            if (path) {
              handlers.onOpenRecent(path)
            }
            return
          case "file-add-files":
            handlers.activeSession()?.addFilesFromPicker()
            return
          case "file-save":
            handlers.activeSession()?.save()
            return
          case "file-save-all":
            handlers.onSaveAll()
            return
          case "file-save-as":
            handlers.activeSession()?.saveAs()
            return
          case "file-fit-a4":
            handlers.activeSession()?.openFitA4()
            return
          case "file-export-images":
            handlers.activeSession()?.openExportImages()
            return
          case "file-split":
            handlers.activeSession()?.openSplit()
            return
          case "file-compress":
            handlers.activeSession()?.openCompress()
            return
          case "file-close-tab":
            if (handlers.activeId !== HOME_TAB_ID) {
              handlers.onCloseTab(handlers.activeId)
            }
            return
          case "file-close-all":
            handlers.onCloseAll()
            return
          case "file-close-window":
            void getCurrentWindow().close()
            return
          case "edit-find":
            handlers.activeSession()?.openSearch()
            return
          case "tool-highlight":
            handlers.activeSession()?.toggleTool("highlight")
            return
          case "tool-rect":
            handlers.activeSession()?.toggleTool("rect")
            return
          case "tool-text-note":
            handlers.activeSession()?.toggleTool("textNote")
            return
          case "tool-eraser":
            handlers.activeSession()?.toggleTool("eraser")
            return
          case "tool-watermark":
            handlers.activeSession()?.openWatermark()
            return
          case "tool-page-numbers":
            handlers.activeSession()?.openPageNumbers()
            return
          case "view-toggle-sidebar":
            handlers.onToggleSidebar()
            return
          case "view-single":
            handlers.activeSession()?.setViewMode("single")
            return
          case "view-book":
            handlers.activeSession()?.setViewMode("book")
            return
          case "view-zoom-in":
            handlers.activeSession()?.zoom("in")
            return
          case "view-zoom-out":
            handlers.activeSession()?.zoom("out")
            return
          case "view-zoom-reset":
            handlers.activeSession()?.zoom("actual-size")
            return
          case "view-zoom-fit-width":
            handlers.activeSession()?.zoomFit("fit-width")
            return
          case "view-zoom-fit-page":
            handlers.activeSession()?.zoomFit("fit-page")
            return
          default:
            break
        }
      },
      { target: label },
    )
      .then((stop) => {
        if (cancelled) {
          stop()
        } else {
          unlisten = stop
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn("macOS menu listener registration failed:", error)
        }
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [enabled])
}
