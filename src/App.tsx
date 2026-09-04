import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
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
import { DismissibleAlert } from "@/components/DismissibleAlert"
import { DocumentTabs } from "@/components/DocumentTabs"
import { HomePanel } from "@/components/HomePanel"
import { MergeWizard } from "@/components/MergeWizard"
import { MergeWizardButton } from "@/components/MergeWizardButton"
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
import {
  useMergeWizard,
  type MergeWizardResult,
} from "@/hooks/useMergeWizard"
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
  fileNameFromPath,
  isPdfPath,
  type PdfDocumentInfo,
} from "@/lib/pdf"
import { isMacOS, isWindows } from "@/lib/platform"
import type { PdfOwnedLayerProgressHandler } from "@/lib/progress"
import { readRecentFiles, type RecentFile } from "@/lib/recentFiles"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import { cn } from "@/lib/utils"
import type { ViewMode } from "@/lib/viewMode"
import type { WatermarkConfig } from "@/lib/watermark"

type OpenTab = {
  dirty: boolean
  document: PdfDocumentInfo
  id: number
  name: string
  path: string
  /** What a document the app itself built opens with, over and above the file
      it was read from: the merge wizard's view and its two page-content
      layers. Absent for every ordinary open. */
  opensWith?: {
    onLayerProgress?: PdfOwnedLayerProgressHandler
    onLayersSettled?: () => void
    pageNumbers: PageNumbersConfig | null
    viewMode: ViewMode
    watermark: WatermarkConfig | null
  }
}

type WorkspaceError =
  | "createFailed"
  | "fileTooLarge"
  | "invalidFile"
  | "openFailed"
  | null
type PendingClose =
  | { kind: "all" }
  | { kind: "tab"; documentId: number }
  | { kind: "window" }

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
  const [workspaceError, setWorkspaceError] = useState<WorkspaceError>(null)
  const [workspaceErrorVersion, setWorkspaceErrorVersion] = useState(0)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const dismissWorkspaceError = useCallback(() => setWorkspaceError(null), [])
  const showWorkspaceError = useCallback(
    (error: NonNullable<WorkspaceError>) => {
      setWorkspaceError(error)
      // The same refusal can happen twice before the first notice expires. Its
      // identity still changes so the second occurrence gets a full lifetime.
      setWorkspaceErrorVersion((version) => version + 1)
    },
    [],
  )
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

    activeIdRef.current = tabId
    setActiveId(tabId)
    focusWorkspaceTarget(tabId)
  }, [])

  // Every way a document reaches the workspace runs through here: they queue
  // behind one another rather than racing over which tab ends up active, and
  // they share the one busy state the strip and the home panel read.
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
        showWorkspaceError("invalidFile")
        return Promise.resolve()
      }

      return runOpenBatch(async () => {
        const openedIds: number[] = []
        let firstError: WorkspaceError = null

        for (const path of pdfPaths) {
          const existingId = tabIdForPath(tabsRef.current, path)

          if (existingId !== null) {
            openedIds.push(existingId)
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

            const tab: OpenTab = {
              dirty: false,
              document,
              id: document.id,
              name: fileNameFromPath(path),
              path,
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
            showWorkspaceError(firstError)
          } else {
            dismissWorkspaceError()
          }
        } else if (firstError) {
          showWorkspaceError(firstError)
        }
      })
    },
    [
      activateTab,
      dismissWorkspaceError,
      replaceTabs,
      runOpenBatch,
      showWorkspaceError,
    ],
  )

  // A new document is the app's own rather than a file's: with no path it
  // matches no open tab and has nothing to be saved back over, so it lives on
  // in the workspace until an export gives it a file.
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
          }
          replaceTabs((current) => [...current, tab])
          activateTab(tab.id)
          dismissWorkspaceError()
        } catch {
          showWorkspaceError("createFailed")
        }
      }),
    [
      activateTab,
      dismissWorkspaceError,
      replaceTabs,
      runOpenBatch,
      showWorkspaceError,
      t,
    ],
  )

  // A merged document is the app's own, like a new one: it has no file behind
  // it, so it lives in the workspace until an export gives it one — which is
  // the only way it can be written, since it holds other files' pages.
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
        dirty: false,
        document,
        id: document.id,
        name: t("mergeWizard.mergedName"),
        opensWith: {
          onLayerProgress: hasInitialLayers ? onLayerProgress : undefined,
          onLayersSettled: hasInitialLayers ? onLayersSettled : undefined,
          pageNumbers,
          viewMode: "thumbnail",
          watermark,
        },
        path: "",
      }

      replaceTabs((current) => [...current, tab])
      activateTab(tab.id)
      dismissWorkspaceError()

      return layersSettled
    },
    [activateTab, dismissWorkspaceError, replaceTabs, t],
  )
  const mergeWizard = useMergeWizard({ onMerged: openMergeResult })

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
      showWorkspaceError("openFailed")
    } finally {
      choosingFileRef.current = false
    }
  }, [openPaths, showWorkspaceError, t])

  const removeTabNow = useCallback(
    (documentId: number) => {
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
    },
    [replaceTabs],
  )

  const requestCloseTab = useCallback(
    (documentId: number) => {
      if (sessionRefs.current.get(documentId)?.hasUnsavedWorkNow()) {
        setPendingClose({ kind: "tab", documentId })
      } else {
        removeTabNow(documentId)
      }
    },
    [removeTabNow],
  )

  const removeAllTabsNow = useCallback(() => {
    replaceTabs(() => [])
    activeIdRef.current = HOME_TAB_ID
    setActiveId(HOME_TAB_ID)
    focusWorkspaceTarget(HOME_TAB_ID, true)
  }, [replaceTabs])

  // One question for the lot, rather than a dialog per dirty document: the
  // reader asked to close everything, and answering the same prompt five times
  // is not five decisions.
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
      removeAllTabsNow()
    }
  }, [removeAllTabsNow])

  // An export that adopted its destination has given a document its first file.
  // The tab follows it: the name the reader now knows it by, and the path the
  // duplicate-open check reads.
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

  const menuActions: AppMenuActions = useMemo(
    () => ({
      canCloseAll: tabs.length > 0,
      onCloseAll: requestCloseAll,
      onMergeWizard: mergeWizard.openWizard,
      onNew: () => void createDocument(),
      onOpen: () => void chooseFile(),
      onOpenRecent: (path) => void openPaths([path]),
      onRefreshRecent: refreshRecentFiles,
      recentFiles,
    }),
    [
      chooseFile,
      createDocument,
      mergeWizard.openWizard,
      openPaths,
      recentFiles,
      refreshRecentFiles,
      requestCloseAll,
      tabs.length,
    ],
  )

  // The drop listener is bound once, so what a drop should do is read from a
  // ref rather than captured: while the wizard is open the files join its list
  // instead of opening as tabs of their own.
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

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    // Only `enter` and `drop` name the files; `over` — the event that moves the
    // insertion line — carries a position and nothing else. Held from the enter
    // so the grid can refuse to promise a landing place for a file it cannot
    // take. Unknown (a listener bound mid-drag) is not "none".
    let draggedPaths: string[] | null = null

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "leave") {
          draggedPaths = null
          dragToSession({ kind: "leave" })
          setIsDragging(false)
          return
        }

        // wry reports the pointer in the window's own units and Tauri labels
        // them physical either way: WebView2 really does hand over device
        // pixels, while Cocoa's `draggingLocation` and GTK's widget coordinates
        // are already the logical ones the page hit-tests with.
        const scale = isWindows() ? window.devicePixelRatio : 1
        const point = {
          x: event.payload.position.x / scale,
          y: event.payload.position.y / scale,
        }

        if (event.payload.type === "drop") {
          draggedPaths = null
          setIsDragging(false)

          const toWizard = wizardDropRef.current

          // The wizard is modal, so it takes every drop while it is open; the
          // thumbnail grid takes one that points at a gap in it; anything else
          // opens as tabs.
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

        if (hasUnsaved) {
          event.preventDefault()
          setPendingClose({ kind: "window" })
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
  }, [])

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

  const errorMessage =
    workspaceError === "createFailed"
      ? t("menu.newFailed")
      : workspaceError === "fileTooLarge"
        ? t("viewer.fileTooLarge")
        : workspaceError === "invalidFile"
          ? t("viewer.invalidFile")
          : workspaceError === "openFailed"
            ? t("viewer.openFailed")
            : null

  return (
    <div className="h-svh overflow-hidden bg-background">
      {homeActive ? (
        // The document tools — bookmarks, view mode — have no document to act
        // on here, so the home header carries only what still works.
        <header
          className="fixed inset-x-0 top-0 z-50 flex h-12 items-center justify-between border-b bg-background/95 px-2 pb-px shadow-xs backdrop-blur"
          data-tauri-drag-region="deep"
        >
          {/* Left, as in a document's header: the menu is the window's, so it
              keeps one place whichever tab is showing. */}
          <div className={cn("flex items-center", macOS && "pl-[72px]")}>
            <AppMenu {...menuActions} />
          </div>
          <div className="flex items-center gap-2">
            {/* The home tab has no document toolbar, and the wizard is the one
                tool there that needs no document — so it keeps the look it has
                in that toolbar, as a group of its own. */}
            <ButtonGroup>
              <MergeWizardButton onClick={mergeWizard.openWizard} />
            </ButtonGroup>
            {macOS ? null : <WindowControls />}
          </div>
        </header>
      ) : null}

      <HomePanel
        active={homeActive}
        // Only the showing panel carries the message: two live `role="alert"`
        // nodes for one error is one too many for a screen reader to reach.
        errorKey={workspaceErrorVersion}
        errorMessage={homeActive ? errorMessage : null}
        onDismissError={dismissWorkspaceError}
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
          initialPageNumbers={tab.opensWith?.pageNumbers}
          initialViewMode={tab.opensWith?.viewMode}
          initialWatermark={tab.opensWith?.watermark}
          key={tab.id}
          menu={menuActions}
          onDirtyChange={updateDirty}
          onInitialLayerProgress={tab.opensWith?.onLayerProgress}
          onInitialLayersSettled={tab.opensWith?.onLayersSettled}
          onSourceChange={updateSource}
          ref={(handle) => {
            if (handle) {
              sessionRefs.current.set(tab.id, handle)
            } else {
              sessionRefs.current.delete(tab.id)
            }
          }}
        />
      ))}

      <DocumentTabs
        activeId={activeId}
        onActivate={activateTab}
        onClose={requestCloseTab}
        onOpenFile={() => void chooseFile()}
        opening={isOpening}
        tabs={tabs}
      />

      {isDragging ? (
        <div className="pointer-events-none fixed inset-3 top-24 z-60 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <FileUp className="mb-4 size-12" />
            <p className="text-lg font-semibold">
              {mergeWizard.open ? t("viewer.dropNowMerge") : t("tabs.dropNow")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {mergeWizard.open
                ? t("mergeWizard.filesDescription")
                : t("tabs.dropHint")}
            </p>
          </div>
        </div>
      ) : null}

      {!homeActive && errorMessage ? (
        <DismissibleAlert
          className="fixed top-25 right-4 z-60 max-w-80 rounded-lg border border-destructive/20 bg-background px-4 py-2 text-sm text-destructive shadow-lg"
          dismissKey={workspaceErrorVersion}
          onDismiss={dismissWorkspaceError}
        >
          {errorMessage}
        </DismissibleAlert>
      ) : null}

      <MergeWizard wizard={mergeWizard} />

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
                  removeTabNow(action.documentId)
                } else if (action?.kind === "all") {
                  removeAllTabsNow()
                } else if (action?.kind === "window") {
                  void getCurrentWindow().destroy()
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
