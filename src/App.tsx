import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { FileUp } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import {
  DocumentSession,
  type DocumentSessionHandle,
  type FileDragEvent,
} from "@/components/DocumentSession"
import { DocumentTabs } from "@/components/DocumentTabs"
import { HomePanel } from "@/components/HomePanel"
import { MergeWizard } from "@/components/MergeWizard"
import { MergeWizardButton } from "@/components/MergeWizardButton"
import { NoticeCenter } from "@/components/NoticeCenter"
import { UpdateInstallDialog } from "@/components/UpdateInstallDialog"
import { WindowControls } from "@/components/WindowControls"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ButtonGroup } from "@/components/ui/button-group"
import { useAppUpdate } from "@/hooks/useAppUpdate"
import { useNotices } from "@/hooks/useNotices"
import {
  useMergeWizard,
  type MergeWizardResult,
} from "@/hooks/useMergeWizard"
import { usePageHandoff } from "@/hooks/usePageHandoff"
import { hasLayerOverWorkspace, isTypingTarget } from "@/lib/contextMenu"
import { e2eOverride, isE2eBuild } from "@/lib/e2e"
import {
  activeTabAfterClose,
  HOME_TAB_ID,
  selectOpenedTabId,
  tabElementId,
  tabIdForPath,
  type TabId,
} from "@/lib/documentTabs"
import {
  noticeEntry,
  openRefusals,
  updateNotice,
  workspaceOwner,
  type Notice,
  type NoticeKind,
} from "@/lib/notices"
import {
  fileNameFromPath,
  isPdfPath,
  type PdfDocumentInfo,
} from "@/lib/pdf"
import { isMacOS, isWindows } from "@/lib/platform"
import type { PdfOwnedLayerProgressHandler } from "@/lib/progress"
import {
  readRecentFiles,
  readRecentPdfView,
  type RecentFile,
  type RecentPdfView,
} from "@/lib/recentFiles"
import { matchesShortcut, shortcuts, type Shortcut } from "@/lib/shortcuts"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import { cn } from "@/lib/utils"
import type { ViewMode } from "@/lib/viewMode"
import type { WatermarkConfig } from "@/lib/watermark"

type OpenTab = {
  dirty: boolean
  document: PdfDocumentInfo
  id: number
  initialSaveRequired?: boolean
  name: string
  path: string
  /** A document-specific name for Save As; ordinary PDFs use the annotation
      export name. */
  saveAsDefaultName?: string
  /** What the session says: a file behind it, changes to write, and no
      session-owned page content that makes it export-only. */
  savable: boolean
  /** The path whose Rust-side open put it in the recent list; unlike `path`,
      absent when an app-created document adopts its first export destination. */
  recentPath?: string
  recentView?: RecentPdfView
  /** What an app-built document opens with over and above its file — the
      merge wizard's view and layers. Absent for every ordinary open. */
  opensWith?: {
    onLayerProgress?: PdfOwnedLayerProgressHandler
    onLayersSettled?: () => void
    pageNumbers: PageNumbersConfig | null
    viewMode: ViewMode
    watermark: WatermarkConfig | null
  }
}

type PendingClose =
  | { kind: "all" }
  | { kind: "tab"; documentId: number }
  | { kind: "window" }

/** What `launch.rs` emits when the OS has a PDF for this window; named in both
    places, so the two have to be changed together. */
const OPEN_REQUESTED_EVENT = "launch://open-requested"

const FOCUS_DOCUMENT_EVENT = "workspace://focus-document"

function hasUsableFocus() {
  const focused = document.activeElement

  return (
    focused instanceof HTMLElement &&
    focused !== document.body &&
    focused.isConnected &&
    !focused.closest("[hidden]")
  )
}

/** Puts focus on the tab that now leads the workspace — the one control that
    is always on screen, whichever panel is showing behind it. */
function focusWorkspaceTarget(activeId: TabId, force = false) {
  requestAnimationFrame(() => {
    if (!force && hasUsableFocus()) {
      return
    }

    document.getElementById(tabElementId(activeId))?.focus()
  })
}

export default function App() {
  const { t } = useTranslation()
  const macOS = isMacOS()
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeId, setActiveId] = useState<TabId>(HOME_TAB_ID)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
  const [isOpening, setIsOpening] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [confirmingInstall, setConfirmingInstall] = useState(false)
  const { channel: notices, notices: raisedNotices } = useNotices()
  const tabsRef = useRef<OpenTab[]>([])
  const sessionRefs = useRef(new Map<number, DocumentSessionHandle>())
  const openChainRef = useRef<Promise<void>>(Promise.resolve())
  const openBatchesRef = useRef(0)
  const choosingFileRef = useRef(false)
  const mountedRef = useRef(true)
  const activeIdRef = useRef<TabId>(HOME_TAB_ID)

  const replaceTabs = useCallback(
    (update: (current: OpenTab[]) => OpenTab[]) => {
      const next = update(tabsRef.current)
      tabsRef.current = next
      setTabs(next)
      return next
    },
    [],
  )

  const refreshRecentFiles = useCallback(() => {
    void readRecentFiles().then((files) => {
      if (mountedRef.current) {
        setRecentFiles(files)
      }
    })
  }, [])

  const activateTab = useCallback((tabId: TabId) => {
    if (
      tabId !== HOME_TAB_ID &&
      !tabsRef.current.some((tab) => tab.id === tabId)
    ) {
      return
    }

    const leavingId = activeIdRef.current

    if (leavingId !== HOME_TAB_ID && leavingId !== tabId) {
      // Capture while the old panel still has a layout box. Once React hides
      // it there is no page geometry left from which to read an exact point.
      void sessionRefs.current.get(leavingId)?.rememberViewNow()
    }

    activeIdRef.current = tabId
    setActiveId(tabId)
    focusWorkspaceTarget(tabId)
  }, [])

  const { armedTabId, handoff } = usePageHandoff({
    activeIdRef,
    onActivate: activateTab,
    sessions: sessionRefs,
  })

  // Every open queues behind the last rather than racing over which tab ends
  // up active, and shares the one busy state the strip and home panel read.
  const runOpenBatch = useCallback(
    (run: () => Promise<void>) => {
      openBatchesRef.current += 1
      setIsOpening(true)

      const queued = openChainRef.current.then(run, run)
      openChainRef.current = queued.then(
        () => undefined,
        () => undefined,
      )

      return queued.finally(() => {
        openBatchesRef.current -= 1

        if (mountedRef.current && openBatchesRef.current === 0) {
          setIsOpening(false)
          // The backend records what it opened, so the home tab's list is
          // read back rather than guessed at from here.
          refreshRecentFiles()
        }
      })
    },
    [refreshRecentFiles],
  )

  const openPaths = useCallback(
    (paths: string[], activate: "first" | "last" = "last") => {
      const pdfPaths = paths.filter(isPdfPath)

      if (pdfPaths.length === 0) {
        notices.raise({ kind: "invalidFile", owner: workspaceOwner })
        return Promise.resolve()
      }

      return runOpenBatch(async () => {
        const openedIds: number[] = []
        let firstError: NoticeKind | null = null

        for (const path of pdfPaths) {
          const existingId = tabIdForPath(tabsRef.current, path)

          if (existingId !== null) {
            openedIds.push(existingId)
            continue
          }

          // Independent edit histories over the same file would overwrite each other on save.
          const heldElsewhere = await invoke<boolean>("focus_pdf_path", {
            path,
          }).catch(() => false)

          if (heldElsewhere) {
            notices.retract(workspaceOwner, openRefusals)
            continue
          }

          try {
            const override = e2eOverride("openPdfFromPath")
            const document = override
              ? ((await override(path)) as PdfDocumentInfo)
              : await invoke<PdfDocumentInfo>("open_pdf_from_path", { path })

            if (!mountedRef.current) {
              void invoke("close_pdf", { documentId: document.id }).catch(
                () => undefined,
              )
              continue
            }

            const duplicateId = tabIdForPath(tabsRef.current, path)

            if (duplicateId !== null) {
              void invoke("close_pdf", { documentId: document.id }).catch(
                () => undefined,
              )
              openedIds.push(duplicateId)
              continue
            }

            const recentView = await readRecentPdfView(path)

            if (!mountedRef.current) {
              void invoke("close_pdf", { documentId: document.id }).catch(
                () => undefined,
              )
              continue
            }

            const tab: OpenTab = {
              dirty: false,
              document,
              id: document.id,
              name: fileNameFromPath(path),
              path,
              recentPath: path,
              recentView: recentView ?? undefined,
              savable: false,
            }
            replaceTabs((current) => [...current, tab])
            openedIds.push(tab.id)
          } catch (error) {
            firstError ??= String(error).includes("MiB limit")
              ? "fileTooLarge"
              : "openFailed"
          }
        }

        if (!mountedRef.current) {
          return
        }

        const selectedId = selectOpenedTabId(
          openedIds,
          tabsRef.current.map((tab) => tab.id),
          activate,
        )

        if (selectedId !== null) {
          activateTab(selectedId)

          if (firstError) {
            notices.raise({ kind: firstError, owner: workspaceOwner })
          } else {
            notices.retract(workspaceOwner, openRefusals)
          }
        } else if (firstError) {
          notices.raise({ kind: firstError, owner: workspaceOwner })
        }
      })
    },
    [activateTab, notices, replaceTabs, runOpenBatch],
  )

  // The app's own rather than a file's: no path means no tab to match and
  // nothing to save back over, until an export gives it a file.
  const createDocument = useCallback(
    () =>
      runOpenBatch(async () => {
        try {
          const document = await invoke<PdfDocumentInfo>("create_pdf")

          if (!mountedRef.current) {
            void invoke("close_pdf", { documentId: document.id }).catch(
              () => undefined,
            )
            return
          }

          const tab: OpenTab = {
            dirty: false,
            document,
            id: document.id,
            name: t("menu.untitled"),
            path: "",
            savable: false,
          }
          replaceTabs((current) => [...current, tab])
          activateTab(tab.id)
          notices.retract(workspaceOwner, openRefusals)
        } catch {
          notices.raise({ kind: "createFailed", owner: workspaceOwner })
        }
      }),
    [activateTab, notices, replaceTabs, runOpenBatch, t],
  )

  const openNewWindow = useCallback(() => {
    void invoke("open_new_window").catch(() =>
      notices.raise({ kind: "newWindowFailed", owner: workspaceOwner }),
    )
  }, [notices])

  // The app's own, like a new one, and export-only: it holds other files'
  // pages, so a chosen destination is the only thing it can be written to.
  const openMergeResult = useCallback(
    (
      { document, pageNumbers, watermark }: MergeWizardResult,
      onLayerProgress: PdfOwnedLayerProgressHandler,
    ) => {
      if (!mountedRef.current) {
        void invoke("close_pdf", { documentId: document.id }).catch(
          () => undefined,
        )
        return Promise.resolve()
      }

      const hasInitialLayers = pageNumbers !== null || watermark !== null
      let resolveLayers: () => void = () => undefined
      const layersSettled = hasInitialLayers
        ? new Promise<void>((resolve) => {
            resolveLayers = resolve
          })
        : Promise.resolve()
      let didSettle = false
      const onLayersSettled = () => {
        if (!didSettle) {
          didSettle = true
          resolveLayers()
        }
      }
      const tab: OpenTab = {
        dirty: true,
        document,
        id: document.id,
        initialSaveRequired: true,
        name: t("mergeWizard.mergedName"),
        opensWith: {
          onLayerProgress: hasInitialLayers ? onLayerProgress : undefined,
          onLayersSettled: hasInitialLayers ? onLayersSettled : undefined,
          pageNumbers,
          viewMode: "thumbnail",
          watermark,
        },
        path: "",
        saveAsDefaultName: t("mergeWizard.mergedName"),
        savable: false,
      }

      replaceTabs((current) => [...current, tab])
      activateTab(tab.id)
      notices.retract(workspaceOwner, openRefusals)

      return layersSettled
    },
    [activateTab, notices, replaceTabs, t],
  )
  const mergeWizard = useMergeWizard({ onMerged: openMergeResult })
  const appUpdate = useAppUpdate()
  const { installFailed, status, visible } = appUpdate
  const update = useMemo(
    () => updateNotice({ installFailed, status, visible }),
    [installFailed, status, visible],
  )

  // Mirrored rather than raised: the check belongs to the backend and is shared
  // by every window, so the corner follows it instead of remembering it.
  useEffect(() => {
    if (update) {
      notices.raise(update)
    } else {
      // Any one of the update's kinds names the whole slot they share.
      notices.retract(workspaceOwner, ["updateAvailable"])
    }

    // A confirmation outliving the offer behind it would install what is no
    // longer ready, and spring open by itself the next time one is shown.
    if (update?.action?.kind !== "updateInstall") {
      setConfirmingInstall(false)
    }
  }, [notices, update])

  const runNoticeAction = useCallback(
    (notice: Notice) => {
      const kind = notice.action?.kind

      if (kind === "updateDownload" || kind === "updateRetry") {
        appUpdate.download()
      } else if (kind === "updateInstall") {
        setConfirmingInstall(true)
      } else if (kind === "noteFont" && notice.owner.scope === "document") {
        sessionRefs.current.get(notice.owner.documentId)?.fetchNoteFont()
      }
    },
    [appUpdate],
  )

  // Two notices own their dismissal: the update, waved away while it says the
  // same thing, and the font offer, which takes its held edit with it.
  const dismissNotice = useCallback(
    (notice: Notice) => {
      const slot = noticeEntry(notice.kind).slot

      if (slot === "update") {
        appUpdate.dismiss()
      } else if (slot === "noteFont" && notice.owner.scope === "document") {
        sessionRefs.current.get(notice.owner.documentId)?.dismissNoteFont()
      }

      notices.dismiss(notice.id)
    },
    [appUpdate, notices],
  )

  const chooseFile = useCallback(async () => {
    if (choosingFileRef.current) {
      return
    }

    choosingFileRef.current = true

    try {
      const pick = e2eOverride("pickPdfPath")
      const path = pick
        ? await pick()
        : await invoke<string | null>("pick_pdf_path", {
            filterLabel: t("annotate.exportFilter"),
          })

      if (typeof path === "string") {
        await openPaths([path])
      }
    } catch {
      notices.raise({ kind: "openFailed", owner: workspaceOwner })
    } finally {
      choosingFileRef.current = false
    }
  }, [notices, openPaths, t])

  const rememberAllViews = useCallback(
    () =>
      Promise.all(
        [...sessionRefs.current.values()].map((session) =>
          session.rememberViewNow(),
        ),
      ).then(() => undefined),
    [],
  )

  const removeTabNow = useCallback(
    (documentId: number) => {
      // Captured synchronously while the panel still has geometry, but not
      // waited on: waiting leaves a document editable after its unsaved-work check.
      const remembered =
        sessionRefs.current.get(documentId)?.rememberViewNow() ??
        Promise.resolve()

      const current = tabsRef.current
      const currentActiveId = activeIdRef.current
      const candidateId = activeTabAfterClose(
        [HOME_TAB_ID, ...current.map((tab) => tab.id)],
        currentActiveId,
        documentId,
      )
      const next = replaceTabs((existing) =>
        existing.filter((tab) => tab.id !== documentId),
      )
      // Taken back here rather than on the session's own unmount, which
      // StrictMode runs twice for every mount it makes.
      notices.retract({ documentId, scope: "document" })
      const nextActiveId =
        candidateId === HOME_TAB_ID ||
        next.some((tab) => tab.id === candidateId)
          ? candidateId
          : HOME_TAB_ID

      if (nextActiveId !== currentActiveId) {
        activeIdRef.current = nextActiveId
        setActiveId(nextActiveId)
      }

      focusWorkspaceTarget(nextActiveId, true)

      return remembered
    },
    [notices, replaceTabs],
  )

  const requestCloseTab = useCallback(
    (documentId: number) => {
      if (sessionRefs.current.get(documentId)?.hasUnsavedWorkNow()) {
        setPendingClose({ kind: "tab", documentId })
      } else {
        void removeTabNow(documentId)
      }
    },
    [removeTabNow],
  )

  const removeAllTabsNow = useCallback(() => {
    // `rememberAllViews` captures every visible value up front; the sessions
    // go now so no edit slips between the dirty check and the close.
    const remembered = rememberAllViews()

    for (const tab of tabsRef.current) {
      notices.retract({ documentId: tab.id, scope: "document" })
    }

    replaceTabs(() => [])
    activeIdRef.current = HOME_TAB_ID
    setActiveId(HOME_TAB_ID)
    focusWorkspaceTarget(HOME_TAB_ID, true)

    return remembered
  }, [notices, rememberAllViews, replaceTabs])

  // One question for the lot: the reader asked to close everything, and the
  // same prompt five times is not five decisions.
  const requestCloseAll = useCallback(() => {
    if (tabsRef.current.length === 0) {
      return
    }

    const anyUnsaved = tabsRef.current.some((tab) =>
      sessionRefs.current.get(tab.id)?.hasUnsavedWorkNow(),
    )

    if (anyUnsaved) {
      setPendingClose({ kind: "all" })
    } else {
      void removeAllTabsNow()
    }
  }, [removeAllTabsNow])

  // An adopted export destination gives the document its first file; the tab
  // follows with the reader's name and the duplicate-open check's path.
  const updateSource = useCallback(
    (documentId: number, path: string) => {
      replaceTabs((current) =>
        current.map((tab) =>
          tab.id === documentId
            ? { ...tab, name: fileNameFromPath(path), path }
            : tab,
        ),
      )
    },
    [replaceTabs],
  )

  const updateDirty = useCallback(
    (documentId: number, dirty: boolean) => {
      replaceTabs((current) => {
        const tab = current.find((item) => item.id === documentId)

        if (!tab || tab.dirty === dirty) {
          return current
        }

        return current.map((item) =>
          item.id === documentId ? { ...item, dirty } : item,
        )
      })
    },
    [replaceTabs],
  )

  const updateSavable = useCallback(
    (documentId: number, savable: boolean) => {
      replaceTabs((current) => {
        const tab = current.find((item) => item.id === documentId)

        if (!tab || tab.savable === savable) {
          return current
        }

        return current.map((item) =>
          item.id === documentId ? { ...item, savable } : item,
        )
      })
    },
    [replaceTabs],
  )

  // Only where a document may be written back: a watermark or another file's
  // pages makes it export-only, and an export wants its own destination.
  const saveAllDocuments = useCallback(() => {
    for (const tab of tabsRef.current) {
      sessionRefs.current.get(tab.id)?.save()
    }
  }, [])

  const canSaveAll = tabs.some((tab) => tab.savable)

  const menuActions: AppMenuActions = useMemo(
    () => ({
      canCloseAll: tabs.length > 0,
      canSaveAll,
      onCloseAll: requestCloseAll,
      onMergeWizard: mergeWizard.openWizard,
      onNew: () => void createDocument(),
      onNewWindow: openNewWindow,
      onOpen: () => void chooseFile(),
      onOpenRecent: (path) => void openPaths([path]),
      onRefreshRecent: refreshRecentFiles,
      onSaveAll: saveAllDocuments,
      recentFiles,
    }),
    [
      canSaveAll,
      chooseFile,
      createDocument,
      mergeWizard.openWizard,
      openNewWindow,
      openPaths,
      recentFiles,
      refreshRecentFiles,
      requestCloseAll,
      saveAllDocuments,
      tabs.length,
    ],
  )

  // The drop listener is bound once, so it reads a ref: while the wizard is
  // open a drop joins its list instead of opening tabs.
  const wizardDropRef = useRef<((paths: string[]) => void) | null>(null)

  useEffect(() => {
    wizardDropRef.current = mergeWizard.open
      ? (paths) => void mergeWizard.addPaths(paths)
      : null
  }, [mergeWizard.addPaths, mergeWizard.open])

  // The active document's own take on a drag, for the one listener below. Read
  // through the refs it already uses, so the subscription stays bound once.
  const dragToSession = useCallback((event: FileDragEvent) => {
    const tabId = activeIdRef.current

    return (
      tabId !== HOME_TAB_ID &&
      (sessionRefs.current.get(tabId)?.onFileDrag(event) ?? false)
    )
  }, [])

  // The WebView's find bar is replaced by the document's own; consumed even on
  // Home, where there is no current PDF for the interface to search.
  useEffect(() => {
    const openDocumentSearch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !matchesShortcut(event, shortcuts.search, macOS)
      ) {
        return
      }

      event.preventDefault()

      const tabId = activeIdRef.current
      if (tabId !== HOME_TAB_ID) {
        sessionRefs.current.get(tabId)?.openSearch()
      }
    }

    document.addEventListener("keydown", openDocumentSearch)

    return () => document.removeEventListener("keydown", openDocumentSearch)
  }, [macOS])

  // The WebView's own print would put the interface on paper, so the key is
  // consumed everywhere and answered only where there is a document to print.
  useEffect(() => {
    const printDocument = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !matchesShortcut(event, shortcuts.print, macOS)
      ) {
        return
      }

      event.preventDefault()

      // Consumed on every repeat, but answered once: a held key must not let
      // the WebView's own print through, nor lay the pages out again.
      if (event.repeat) {
        return
      }

      // A dialog or popup in front of the document owns the screen — this one
      // included, while it counts out the pages.
      if (hasLayerOverWorkspace()) {
        return
      }

      const tabId = activeIdRef.current
      if (tabId !== HOME_TAB_ID) {
        sessionRefs.current.get(tabId)?.print()
      }
    }

    document.addEventListener("keydown", printDocument)

    return () => document.removeEventListener("keydown", printDocument)
  }, [macOS])

  // The WebView's select-all takes the whole interface, never what a reader
  // means; consumed everywhere, answered only by a document tab.
  useEffect(() => {
    const selectAllInDocument = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !matchesShortcut(event, shortcuts.selectAll, macOS) ||
        isTypingTarget(event.target)
      ) {
        return
      }

      event.preventDefault()

      // A select-all replaces what was selected, so the range a drag left goes
      // too — on the next frame, after any default action this did not stop.
      requestAnimationFrame(() => window.getSelection()?.removeAllRanges())

      // Consumed on every repeat, but answered once: a held key would rebuild
      // the grid's selection set at the repeat rate for nothing.
      if (event.repeat) {
        return
      }

      // A dialog or popup in front of the document owns the screen; the key is
      // still consumed there, since the interface behind it is not selectable.
      if (hasLayerOverWorkspace()) {
        return
      }

      const tabId = activeIdRef.current
      if (tabId !== HOME_TAB_ID) {
        sessionRefs.current.get(tabId)?.selectAll()
      }
    }

    document.addEventListener("keydown", selectAllInDocument)

    return () => document.removeEventListener("keydown", selectAllInDocument)
  }, [macOS])

  useEffect(() => {
    const openAnotherWindow = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !matchesShortcut(event, shortcuts.newWindow, macOS)
      ) {
        return
      }

      // Consumed before the repeat is weighed, so a held chord never leaks the
      // WebView's own answer to it on the second press onwards.
      event.preventDefault()

      if (event.repeat) {
        return
      }

      openNewWindow()
    }

    document.addEventListener("keydown", openAnotherWindow)

    return () => document.removeEventListener("keydown", openAnotherWindow)
  }, [macOS, openNewWindow])

  // Bound to this document rather than registered with the OS: they are the
  // window's while it is focused, and take nothing from the desktop around it.
  useEffect(() => {
    const activeSession = () => {
      const tabId = activeIdRef.current

      return tabId === HOME_TAB_ID ? undefined : sessionRefs.current.get(tabId)
    }

    const actions: Array<{
      fieldFirst?: boolean
      run: () => void
      shortcut: Shortcut
    }> = [
      { run: () => void createDocument(), shortcut: shortcuts.new },
      { run: () => void chooseFile(), shortcut: shortcuts.open },
      { run: () => activeSession()?.save(), shortcut: shortcuts.save },
      { run: () => activeSession()?.saveAs(), shortcut: shortcuts.saveAs },
      { run: saveAllDocuments, shortcut: shortcuts.saveAll },
      {
        run: () => activeSession()?.openWatermark(),
        shortcut: shortcuts.watermark,
      },
      {
        run: () => activeSession()?.openPageNumbers(),
        shortcut: shortcuts.pageNumbers,
      },
      // A field's own undo is the one the reader means while typing in it.
      {
        fieldFirst: true,
        run: () => activeSession()?.undo(),
        shortcut: shortcuts.undo,
      },
    ]

    const runShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return
      }

      const action = actions.find((candidate) =>
        matchesShortcut(event, candidate.shortcut, macOS),
      )

      if (!action || (action.fieldFirst && isTypingTarget(event.target))) {
        return
      }

      // Consumed wherever the app holds the keyboard: the WebView's own answers
      // to these keys act on the interface, which is never what is meant here.
      event.preventDefault()

      // Answered once for a held key, and never under a dialog or popup: while
      // one stands, the screen — and the keyboard with it — is its own.
      if (event.repeat || hasLayerOverWorkspace()) {
        return
      }

      action.run()
    }

    document.addEventListener("keydown", runShortcut)

    return () => document.removeEventListener("keydown", runShortcut)
  }, [chooseFile, createDocument, macOS, saveAllDocuments])

  // No in-app drag uses the browser's own drag and drop, so one starting here
  // is refused where it starts, never reaching the file handler below.
  useEffect(() => {
    const refuseDrag = (event: DragEvent) => event.preventDefault()

    document.addEventListener("dragstart", refuseDrag)

    return () => document.removeEventListener("dragstart", refuseDrag)
  }, [])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    // Only `enter` and `drop` name the files — `over` carries a position and
    // nothing else — and unknown (a listener bound mid-drag) is not "none".
    let draggedPaths: string[] | null = null
    // The OS reports drags of anything at all, and one naming no file has
    // nothing to open: left alone rather than met with a drop target and an error.
    let namesNoFile = false

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // A drop naming no file ends its drag the way a `leave` does: nothing
        // was ever offered, so nothing lands.
        if (
          event.payload.type === "leave" ||
          (event.payload.type === "drop" && event.payload.paths.length === 0)
        ) {
          draggedPaths = null
          namesNoFile = false
          dragToSession({ kind: "leave" })
          setIsDragging(false)
          return
        }

        // Tauri labels the pointer physical either way, but only WebView2
        // really hands over device pixels; Cocoa and GTK give logical ones.
        const scale = isWindows() ? window.devicePixelRatio : 1
        const point = {
          x: event.payload.position.x / scale,
          y: event.payload.position.y / scale,
        }

        if (event.payload.type === "drop") {
          draggedPaths = null
          namesNoFile = false
          setIsDragging(false)

          const toWizard = wizardDropRef.current

          // The modal wizard takes every drop while open; the grid takes one
          // pointing at a gap in it; anything else opens as tabs.
          if (toWizard) {
            toWizard(event.payload.paths)
          } else if (
            !dragToSession({ kind: "drop", paths: event.payload.paths, point })
          ) {
            void openPaths(event.payload.paths, "first")
          }

          return
        }

        if (event.payload.type === "enter") {
          draggedPaths = event.payload.paths
          namesNoFile = draggedPaths.length === 0
        }

        if (namesNoFile) {
          return
        }

        // The grid draws its own insertion line, so the workspace's full-window
        // drop target would only cover the answer the reader is aiming at.
        const claimed =
          !wizardDropRef.current &&
          dragToSession({ kind: "over", paths: draggedPaths, point })

        setIsDragging(!claimed)
      })
      .then((stop) => {
        if (cancelled) {
          stop()
        } else {
          unlisten = stop
        }
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [dragToSession, openPaths])

  // A double-clicked PDF reaches the app before this workspace exists, so Rust
  // holds it: the event carries no paths, only that a take will find some.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    const openWhatTheOsNamed = () =>
      invoke<string[]>("take_launch_pdfs")
        .then((paths) => {
          // Not conditioned on `cancelled`: a take that emptied the queue is
          // the only chance these paths get; `openPaths` guards unmounted itself.
          if (paths.length > 0) {
            void openPaths(paths, "first")
          }
        })
        .catch(() => undefined)

    // Bound before the first take, so a file arriving between the two is
    // announced to a listener that is already there rather than to nobody.
    void listen(OPEN_REQUESTED_EVENT, () => void openWhatTheOsNamed()).then(
      (stop) => {
        if (cancelled) {
          stop()
          return
        }

        unlisten = stop
        void openWhatTheOsNamed()
      },
      // A subscription that never bound leaves the queue full all the same,
      // and taking it is what opens the file launched this run for.
      () => {
        if (!cancelled) {
          void openWhatTheOsNamed()
        }
      },
    )

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [openPaths])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    void listen<number>(FOCUS_DOCUMENT_EVENT, (event) =>
      activateTab(event.payload),
    ).then((stop) => {
      if (cancelled) {
        stop()
      } else {
        unlisten = stop
      }
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [activateTab])

  useEffect(() => {
    if (isE2eBuild) {
      return
    }

    let cancelled = false
    let unlisten: (() => void) | undefined

    void getCurrentWindow()
      .onCloseRequested((event) => {
        const hasUnsaved = tabsRef.current.some((tab) =>
          sessionRefs.current.get(tab.id)?.hasUnsavedWorkNow(),
        )

        // Even a clean close waits for reading positions to reach Rust, or the
        // process could end ahead of the trailing persistence write.
        event.preventDefault()

        if (hasUnsaved) {
          setPendingClose({ kind: "window" })
        } else {
          void removeAllTabsNow().then(() => getCurrentWindow().destroy())
        }
      })
      .then((stop) => {
        if (cancelled) {
          stop()
        } else {
          unlisten = stop
        }
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [removeAllTabsNow])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  const homeActive = activeId === HOME_TAB_ID

  // Read again on every visit, not just at startup: a file the list points at
  // may have been moved or deleted since, and the backend leaves those out.
  useEffect(() => {
    if (homeActive) {
      refreshRecentFiles()
    }
  }, [homeActive, refreshRecentFiles])

  return (
    <div className="h-svh overflow-hidden bg-background">
      {homeActive ? (
        // The document tools — bookmarks, view mode — have no document to act
        // on here, so the home header carries only what still works.
        <header
          className="fixed inset-x-0 top-0 z-50 flex h-12 items-center justify-between border-b bg-background/95 px-2 pb-px shadow-xs backdrop-blur"
          data-tauri-drag-region="deep"
        >
          <div className={cn("flex items-center", macOS && "pl-[72px]")}>
            <AppMenu {...menuActions} />
          </div>
          <div className="flex items-center gap-2">
            {/* The wizard is the one home tool that needs no document, so it
                keeps the look it has in a document toolbar. */}
            <ButtonGroup>
              <MergeWizardButton onClick={mergeWizard.openWizard} />
            </ButtonGroup>
            {macOS ? null : <WindowControls />}
          </div>
        </header>
      ) : null}

      <HomePanel
        active={homeActive}
        onOpenFile={() => void chooseFile()}
        onOpenRecent={(path) => void openPaths([path])}
        opening={isOpening}
        recentFiles={recentFiles}
      />

      {tabs.map((tab) => (
        <DocumentSession
          active={tab.id === activeId}
          document={tab.document}
          fileName={tab.name}
          initialSaveRequired={tab.initialSaveRequired}
          initialPageNumbers={tab.opensWith?.pageNumbers}
          initialRecentView={tab.recentView}
          initialViewMode={tab.opensWith?.viewMode}
          initialWatermark={tab.opensWith?.watermark}
          key={tab.id}
          menu={menuActions}
          notices={notices}
          onDirtyChange={updateDirty}
          onInitialLayerProgress={tab.opensWith?.onLayerProgress}
          onInitialLayersSettled={tab.opensWith?.onLayersSettled}
          onSavableChange={updateSavable}
          onSourceChange={updateSource}
          pageHandoff={handoff}
          ref={(handle) => {
            if (handle) {
              sessionRefs.current.set(tab.id, handle)
            } else {
              sessionRefs.current.delete(tab.id)
            }
          }}
          recentPath={tab.recentPath}
          saveAsDefaultName={tab.saveAsDefaultName}
        />
      ))}

      <DocumentTabs
        activeId={activeId}
        armedTabId={armedTabId}
        onActivate={activateTab}
        onClose={requestCloseTab}
        onOpenFile={() => void chooseFile()}
        opening={isOpening}
        tabs={tabs}
      />

      {isDragging && !mergeWizard.open ? (
        <div
          className="pointer-events-none fixed inset-3 top-24 z-60 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 backdrop-blur-sm"
          data-testid="workspace-file-drop"
        >
          <div className="flex flex-col items-center text-center">
            <FileUp className="mb-4 size-12" />
            <p className="text-lg font-semibold">{t("tabs.dropNow")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("tabs.dropHint")}
            </p>
          </div>
        </div>
      ) : null}

      <NoticeCenter
        activeDocumentId={activeId === HOME_TAB_ID ? null : activeId}
        notices={raisedNotices}
        onAction={runNoticeAction}
        onDismiss={dismissNotice}
        onExpire={notices.dismiss}
      />

      <UpdateInstallDialog
        onConfirm={() => {
          setConfirmingInstall(false)
          appUpdate.install()
        }}
        onOpenChange={setConfirmingInstall}
        open={confirmingInstall}
      />

      <MergeWizard draggingFiles={isDragging} wizard={mergeWizard} />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingClose(null)
          }
        }}
        open={pendingClose !== null}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("viewer.unsavedTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingClose?.kind === "tab"
                ? t("tabs.unsavedTabDescription")
                : pendingClose?.kind === "all"
                  ? t("tabs.unsavedAllDescription")
                  : t("tabs.unsavedWindowDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("viewer.unsavedCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingClose
                setPendingClose(null)

                if (action?.kind === "tab") {
                  void removeTabNow(action.documentId)
                } else if (action?.kind === "all") {
                  void removeAllTabsNow()
                } else if (action?.kind === "window") {
                  void removeAllTabsNow().then(() =>
                    getCurrentWindow().destroy(),
                  )
                }
              }}
            >
              {pendingClose?.kind === "tab"
                ? t("tabs.discardAndCloseTab")
                : pendingClose?.kind === "all"
                  ? t("tabs.discardAndCloseAll")
                  : t("viewer.unsavedCloseConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
