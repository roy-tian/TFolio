import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Bookmark, FilePlus, FileUp, LoaderCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  DocumentSession,
  type DocumentSessionHandle,
} from "@/components/DocumentSession"
import { DocumentTabs } from "@/components/DocumentTabs"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ViewModeToggle } from "@/components/ViewModeToggle"
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
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { e2eOverride, isE2eBuild } from "@/lib/e2e"
import {
  activeTabAfterClose,
  selectOpenedTabId,
  tabIdForPath,
} from "@/lib/documentTabs"
import {
  fileNameFromPath,
  isPdfPath,
  type PdfDocumentInfo,
} from "@/lib/pdf"
import { isMacOS } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { defaultViewMode, readStoredViewMode } from "@/lib/viewMode"

type OpenTab = {
  dirty: boolean
  document: PdfDocumentInfo
  id: number
  name: string
  path: string
}

type WorkspaceError = "fileTooLarge" | "invalidFile" | "openFailed" | null
type PendingClose = { kind: "tab"; documentId: number } | { kind: "window" }

function hasUsableFocus() {
  const focused = document.activeElement

  return (
    focused instanceof HTMLElement &&
    focused !== document.body &&
    focused.isConnected &&
    !focused.closest("[hidden]")
  )
}

function focusWorkspaceTarget(
  activeId: number | null,
  tabCount: number,
  force = false,
) {
  requestAnimationFrame(() => {
    if (!force && hasUsableFocus()) {
      return
    }

    const target =
      tabCount >= 2 && activeId !== null
        ? document.getElementById(`document-tab-${activeId}`)
        : tabCount === 1
          ? document.querySelector<HTMLElement>(
              "[data-active='true'] [data-slot='session-open-file']",
            )
          : document.querySelector<HTMLElement>(
              "[data-slot='titlebar-open-file'], [data-slot='drop-zone']",
            )

    target?.focus()
  })
}

export default function App() {
  const { t } = useTranslation()
  const macOS = isMacOS()
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [isOpening, setIsOpening] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<WorkspaceError>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  const [emptyViewMode] = useState(
    () => readStoredViewMode() ?? defaultViewMode,
  )
  const tabsRef = useRef<OpenTab[]>([])
  const sessionRefs = useRef(new Map<number, DocumentSessionHandle>())
  const openChainRef = useRef<Promise<void>>(Promise.resolve())
  const openBatchesRef = useRef(0)
  const choosingFileRef = useRef(false)
  const mountedRef = useRef(true)
  const activeIdRef = useRef<number | null>(null)

  const replaceTabs = useCallback(
    (update: (current: OpenTab[]) => OpenTab[]) => {
      const next = update(tabsRef.current)
      tabsRef.current = next
      setTabs(next)
      return next
    },
    [],
  )

  const activateTab = useCallback((documentId: number) => {
    if (!tabsRef.current.some((tab) => tab.id === documentId)) {
      return
    }

    activeIdRef.current = documentId
    setActiveId(documentId)
    focusWorkspaceTarget(documentId, tabsRef.current.length)
  }, [])

  const openPaths = useCallback(
    (paths: string[], activate: "first" | "last" = "last") => {
      const pdfPaths = paths.filter(isPdfPath)

      if (pdfPaths.length === 0) {
        setWorkspaceError("invalidFile")
        return Promise.resolve()
      }

      openBatchesRef.current += 1
      setIsOpening(true)

      const run = async () => {
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
          setWorkspaceError(firstError)
        } else if (firstError) {
          setWorkspaceError(firstError)
        }
      }

      const queued = openChainRef.current.then(run, run)
      openChainRef.current = queued.then(
        () => undefined,
        () => undefined,
      )

      return queued.finally(() => {
        openBatchesRef.current -= 1

        if (mountedRef.current && openBatchesRef.current === 0) {
          setIsOpening(false)
        }
      })
    },
    [activateTab, replaceTabs],
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
      setWorkspaceError("openFailed")
    } finally {
      choosingFileRef.current = false
    }
  }, [openPaths, t])

  const removeTabNow = useCallback(
    (documentId: number) => {
      const current = tabsRef.current
      const currentActiveId = activeIdRef.current
      const candidateId = activeTabAfterClose(
        current.map((tab) => tab.id),
        currentActiveId,
        documentId,
      )
      const next = replaceTabs((existing) =>
        existing.filter((tab) => tab.id !== documentId),
      )
      const nextActiveId = next.some((tab) => tab.id === candidateId)
        ? candidateId
        : next[0]?.id ?? null

      if (nextActiveId !== currentActiveId) {
        activeIdRef.current = nextActiveId
        setActiveId(nextActiveId)
      }

      focusWorkspaceTarget(nextActiveId, next.length, true)
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

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          return
        }

        if (event.payload.type === "enter") {
          setIsDragging(true)
          return
        }

        setIsDragging(false)

        if (event.payload.type === "drop") {
          void openPaths(event.payload.paths, "first")
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
  }, [openPaths])

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

  const tabsVisible = tabs.length >= 2
  const errorMessage =
    workspaceError === "fileTooLarge"
      ? t("viewer.fileTooLarge")
      : workspaceError === "invalidFile"
        ? t("viewer.invalidFile")
        : workspaceError === "openFailed"
          ? t("viewer.openFailed")
          : null

  return (
    <div className="h-svh overflow-hidden bg-background">
      {tabs.length === 0 ? (
        <>
          <header
            className="fixed inset-x-0 top-0 z-50 grid h-12 grid-cols-[1fr_auto] items-center border-b bg-background/95 px-2 pb-px shadow-xs backdrop-blur"
            data-tauri-drag-region="deep"
          >
            <div
              className={cn(
                "flex items-center justify-self-start",
                macOS && "pl-[72px]",
              )}
            >
              <Button
                aria-label={t("tabs.openFile")}
                data-slot="titlebar-open-file"
                disabled={isOpening}
                onClick={() => void chooseFile()}
                size="icon"
                title={t("tabs.openFile")}
                variant="outline"
              >
                {isOpening ? <LoaderCircle className="animate-spin" /> : <FilePlus />}
              </Button>
              <Toggle
                aria-label={t("toolbar.showBookmarks")}
                className="ml-1 size-8"
                disabled
                title={t("toolbar.showBookmarks")}
                variant="outline"
              >
                <Bookmark />
              </Toggle>
              <ViewModeToggle
                disabled
                onChange={() => undefined}
                value={emptyViewMode}
              />
            </div>
            <div className="flex items-center gap-2 justify-self-end">
              <SettingsDialog />
              {macOS ? null : <WindowControls />}
            </div>
          </header>

          <main className="grid h-full place-items-center bg-zinc-200/70 p-8 pt-20 dark:bg-zinc-950">
            <div className="flex w-full max-w-xl flex-col items-center">
              <button
                aria-label={t("viewer.chooseFile")}
                className="group flex w-full cursor-pointer flex-col items-center rounded-2xl border border-dashed border-zinc-400 bg-background/75 px-8 py-14 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
                data-slot="drop-zone"
                disabled={isOpening}
                onClick={() => void chooseFile()}
                type="button"
              >
                {isOpening ? (
                  <LoaderCircle className="mb-5 size-10 animate-spin text-muted-foreground" />
                ) : (
                  <FileUp className="mb-5 size-10 text-muted-foreground transition-transform group-hover:-translate-y-0.5" />
                )}
                <span className="text-lg font-semibold">
                  {isOpening ? t("viewer.loading") : t("viewer.dropTitle")}
                </span>
                <span className="mt-2 text-sm text-muted-foreground">
                  {t("viewer.dropDescription")}
                </span>
              </button>
              {errorMessage ? (
                <span className="mt-4 text-sm text-destructive" role="alert">
                  {errorMessage}
                </span>
              ) : null}
            </div>
          </main>
        </>
      ) : null}

      {tabs.map((tab) => (
        <DocumentSession
          active={tab.id === activeId}
          document={tab.document}
          fileName={tab.name}
          key={tab.id}
          opening={isOpening}
          onCloseDocument={() => requestCloseTab(tab.id)}
          onDirtyChange={updateDirty}
          onOpenFile={() => void chooseFile()}
          ref={(handle) => {
            if (handle) {
              sessionRefs.current.set(tab.id, handle)
            } else {
              sessionRefs.current.delete(tab.id)
            }
          }}
          tabsVisible={tabsVisible}
        />
      ))}

      {tabsVisible && activeId !== null ? (
        <DocumentTabs
          activeId={activeId}
          onActivate={activateTab}
          onClose={requestCloseTab}
          tabs={tabs}
        />
      ) : null}

      {isDragging ? (
        <div
          className={cn(
            "pointer-events-none fixed inset-3 z-60 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 backdrop-blur-sm",
            tabsVisible ? "top-24" : "top-15",
          )}
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

      {tabs.length > 0 && errorMessage ? (
        <div
          className={cn(
            "fixed right-4 z-60 rounded-lg border border-destructive/20 bg-background px-4 py-2 text-sm text-destructive shadow-lg",
            tabsVisible ? "top-25" : "top-16",
          )}
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

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
                } else if (action?.kind === "window") {
                  void getCurrentWindow().destroy()
                }
              }}
            >
              {pendingClose?.kind === "tab"
                ? t("tabs.discardAndCloseTab")
                : t("viewer.unsavedCloseConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
