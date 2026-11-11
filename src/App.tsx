import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { AppWindow, FileUp } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import { AppSidebar } from "@/components/AppSidebar"
import {
  DocumentSession,
  type DocumentSessionHandle,
} from "@/components/DocumentSession"
import { DocumentTabs } from "@/components/DocumentTabs"
import { HomePanel } from "@/components/HomePanel"
import { NoticeCenter } from "@/components/NoticeCenter"
import { ReloadPrompt } from "@/components/ReloadPrompt"
import { SignaturePrompt } from "@/components/SignaturePrompt"
import {
  SettingsDialog,
  type SettingsSection,
} from "@/components/SettingsDialog"
import { ToolbarFrame } from "@/components/SessionHeader"
import { UpdateInstallDialog } from "@/components/UpdateInstallDialog"
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
import { AppUpdateContext, useAppUpdate } from "@/hooks/useAppUpdate"
import { useNotices } from "@/hooks/useNotices"
import { useReopenTab, type Reopened } from "@/hooks/useReopenTab"
import { useSignaturePrompt } from "@/hooks/useSignaturePrompt"
import { PageCarryContext, usePageCarry } from "@/hooks/usePageCarry"
import { PagesDropContext, setPagesDropPoint, type PagesDrop } from "@/hooks/usePagesDrop"
import { SidebarContext, useSidebarState } from "@/hooks/useSidebar"
import { hasLayerOverWorkspace, isTypingTarget } from "@/lib/contextMenu"
import { e2eOverride, isE2eBuild } from "@/lib/e2e"
import { dropPointInCss, overPages, pagesShown } from "@/lib/fileDrop"
import {
  activeTabAfterClose,
  HOME_TAB_ID,
  otherTabIds,
  reorderedTabs,
  selectOpenedTabId,
  tabElementId,
  type OtherTabs,
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
import type { CarriedPages } from "@/lib/pageCarry"
import {
  fileNameFromPath,
  fileStem,
  type PdfDocumentInfo,
} from "@/lib/pdf"
import { isMacOS, isWindows } from "@/lib/platform"
import { sidebarWidthStyle } from "@/lib/sidebar"
import { cn } from "@/lib/utils"
import { findOpenFile } from "@/lib/openFiles"
import {
  classifyOpenSource,
  isSourcePath,
  pdfNameFromSource,
  type OpenSourceKind,
} from "@/lib/openSources"
import {
  readRecentFiles,
  readRecentPdfView,
  removeRecentFile,
  revealRecentFile,
  type RecentFile,
  type RecentPdfView,
} from "@/lib/recentFiles"
import {
  matchesShortcut,
  shortcuts,
  zoomShortcut,
  type Shortcut,
} from "@/lib/shortcuts"
import {
  fetchWindowRects,
  globalPointFrom,
  moveTabToNewWindow,
  moveTabToWindow,
  takeMovedTabs,
  windowAtPoint,
  type MovedTabPayload,
  type MovedTabSeed,
  type WindowRect,
} from "@/lib/tabMove"
import { unsavedWorkElsewhere } from "@/lib/unsavedWork"
import { wordConversionAvailable } from "@/lib/wordConversion"

type OpenTab = {
  /** The image or Word document a converted tab was made from: what a reload
      reads for it while it has no file of its own. */
  convertedFrom?: string
  dirty: boolean
  document: PdfDocumentInfo
  id: number
  initialSaveRequired?: boolean
  /** A tab that arrived from another window: what its session replays, which
      no fresh open could derive. Read once, at the session's first mount. */
  movedSeed?: MovedTabSeed
  name: string
  path: string
  /** A document-specific name for Save As — a converted document's,
      then the file Save As bound it to; ordinary PDFs use the annotation
      export name. */
  saveAsDefaultName?: string
  /** What the session says: a file behind it, changes to write, and no
      session-owned page content that makes it export-only. */
  savable: boolean
  /** The path whose Rust-side open or Save As put it in the recent list —
      absent while an app-created document has no file of its own. */
  recentPath?: string
  recentView?: RecentPdfView
}

/** One open's shared answers: whether Word conversion is available, asked
    when a Word source first needs it, and whether the reader stopped one. */
type OpenBatch = { wordAvailable: boolean | null; wordStopped: boolean }

/** `error` null is a load that ends quietly: stopped, or its page gone. */
type LoadedSource =
  | { kind: "opened"; tab: OpenTab }
  | { error: NoticeKind | null; kind: "failed" }

/** `changes` is whether a save here could keep anything; without them, what
    the close would cost here is only work still running, which no save can
    keep. */
type PendingClose = (
  | { kind: "all" }
  /** `elsewhere`: another window holds unsaved work, or did not answer —
      nothing this window can save. */
  | { kind: "quit"; elsewhere: boolean }
  | { kind: "tab"; documentId: number }
  /** Some tabs, from another tab's menu: `anchorId` is that tab, where the
      workspace lands if the active one goes with them. */
  | { kind: "tabs"; anchorId: number; documentIds: number[] }
  | { kind: "window" }
) & { changes: boolean }

/** What a drag crossing out of this window navigates by: the viewport's place
    on the screen, this window's own label, and every window a release could
    land on — the dragger included, whose body means a tear-off. */
type DragGeometry = {
  origin: { x: number; y: number }
  rects: WindowRect[]
  scale: number
  selfLabel: string
}

/** What `launch.rs` emits when the OS has a PDF for this window; named in both
    places, so the two have to be changed together. */
const OPEN_REQUESTED_EVENT = "launch://open-requested"

/** What `windows.rs` emits when another window was asked to open a file this
    one holds; named in both places, as the launch event above is. */
const REOPEN_DOCUMENT_EVENT = "workspace://reopen-document"

/** What `quit.rs` emits: the macOS menu's Quit, asking this window to run the
    unsaved check, and every window's order to close once it has. */
const QUIT_REQUESTED_EVENT = "app://quit-requested"
const QUIT_EVENT = "app://quit"

/** What `handoff.rs` emits when another window has sent a tab here; named in
    both places, as the launch event above is. */
const TAB_ARRIVED_EVENT = "workspace://tab-arrived"

/** This window's own telling that a dragged tab is passing over it; the
    dragging window emits it, and only the hovered one listens. */
const TAB_HOVER_EVENT = "workspace://tab-hover"

/** The notice an open refusal becomes, whichever door the file came through:
 * the size ceiling words its own refusal, and every other failure is one. */
function noticeForOpenError(error: unknown): NoticeKind {
  return String(error).includes("MiB limit") ? "fileTooLarge" : "openFailed"
}

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
  const sidebar = useSidebarState(macOS)
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeId, setActiveId] = useState<TabId>(HOME_TAB_ID)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])
  const [isOpening, setIsOpening] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [pagesDrop, setPagesDrop] = useState<PagesDrop>(null)
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)
  // What the prompt keeps showing while it fades out after an answer.
  const [shownClose, setShownClose] = useState<PendingClose | null>(null)
  // Another window's tab is held over this one: the overlay it reads while it
  // decides, gone the moment the drag does.
  const [tabHover, setTabHover] = useState<{ name: string } | null>(null)
  const { channel: notices, notices: raisedNotices } = useNotices()
  const tabsRef = useRef<OpenTab[]>([])
  const sessionRefs = useRef(new Map<number, DocumentSessionHandle>())
  const openChainRef = useRef<Promise<void>>(Promise.resolve())
  const openBatchesRef = useRef(0)
  const choosingFileRef = useRef(false)
  const mountedRef = useRef(true)
  const activeIdRef = useRef<TabId>(HOME_TAB_ID)
  // A tab drag that left the strip: where this window's viewport sits on the
  // screen and which of the others the pointer is over. Loaded once per drag —
  // windows cannot move under a pointer the drag is holding.
  const dragGeometryRef = useRef<Promise<DragGeometry | null> | null>(null)
  const hoverTargetRef = useRef<string | null>(null)
  // Set by the notice's Stop, so the conversion's refusal reads as the stop it is.
  const wordStopRef = useRef(false)
  const wordConvertingRef = useRef(false)
  const quitCheckRef = useRef(false)

  const replaceTabs = useCallback(
    (update: (current: OpenTab[]) => OpenTab[]) => {
      const next = update(tabsRef.current)
      tabsRef.current = next
      setTabs(next)
      return next
    },
    [],
  )

  const askToClose = useCallback((close: PendingClose) => {
    setShownClose(close)
    setPendingClose(close)
  }, [])

  const refreshRecentFiles = useCallback(() => {
    void readRecentFiles().then((files) => {
      if (mountedRef.current) {
        setRecentFiles(files)
      }
    })
  }, [])

  // The list is re-read rather than spliced: the backend's answer is the one
  // that also dropped the path's saved view and next-run approval.
  const removeRecent = useCallback(
    (path: string) => {
      void removeRecentFile(path).then(refreshRecentFiles)
    },
    [refreshRecentFiles],
  )

  // A failed reveal is most often a file gone since the list was read: the
  // re-read drops its entry, and the notice says why no folder opened.
  const revealRecent = useCallback(
    (path: string) => {
      void revealRecentFile(path).then((revealed) => {
        if (!revealed) {
          notices.raise({ kind: "revealFailed", owner: workspaceOwner })
          refreshRecentFiles()
        }
      })
    },
    [notices, refreshRecentFiles],
  )

  const showTab = useCallback((tabId: TabId) => {
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

  const tabStillOpen = (tabId: TabId) =>
    tabId === HOME_TAB_ID || tabsRef.current.some((tab) => tab.id === tabId)

  // A dialog or popup in front owns the screen, and its tab's export or edit
  // with it: a tab arriving meanwhile — a launch, a drop, a move, an open
  // finishing late — waits behind it and comes forward once it closes.
  const pendingActivationRef = useRef<TabId | null>(null)
  const layerWatchRef = useRef<MutationObserver | null>(null)

  const activateTab = useCallback(
    (tabId: TabId) => {
      if (!tabStillOpen(tabId)) {
        return
      }

      if (!hasLayerOverWorkspace()) {
        pendingActivationRef.current = null
        showTab(tabId)
        return
      }

      pendingActivationRef.current = tabId

      if (layerWatchRef.current) {
        return
      }

      const watch = new MutationObserver(() => {
        if (hasLayerOverWorkspace()) {
          return
        }

        watch.disconnect()
        layerWatchRef.current = null

        const pending = pendingActivationRef.current
        pendingActivationRef.current = null

        if (pending !== null && tabStillOpen(pending)) {
          showTab(pending)
        }
      })

      layerWatchRef.current = watch
      watch.observe(document.body, { childList: true, subtree: true })
    },
    [showTab],
  )

  useEffect(
    () => () => {
      layerWatchRef.current?.disconnect()
      layerWatchRef.current = null
    },
    [],
  )

  // The strip's drag reorder: pure order among documents, touching nothing
  // behind the tabs it moves.
  const reorderTabs = useCallback(
    (from: number, to: number) => {
      replaceTabs((current) => reorderedTabs(current, from, to))
    },
    [replaceTabs],
  )

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

  // One file read into a tab of its own, not yet on the strip: a fresh open
  // appends it, a reload puts it where the old tab stood.
  const loadSource = useCallback(
    async (
      kind: OpenSourceKind,
      path: string,
      batch: OpenBatch,
    ): Promise<LoadedSource> => {
      if (kind === "pdf") {
        try {
          const override = e2eOverride("openPdfFromPath")
          const document = override
            ? ((await override(path)) as PdfDocumentInfo)
            : await invoke<PdfDocumentInfo>("open_pdf_from_path", { path })
          const recentView = mountedRef.current
            ? await readRecentPdfView(path)
            : null

          if (!mountedRef.current) {
            void invoke("close_pdf", { documentId: document.id }).catch(
              () => undefined,
            )
            return { error: null, kind: "failed" }
          }

          return {
            kind: "opened",
            tab: {
              dirty: false,
              document,
              id: document.id,
              name: fileNameFromPath(path),
              path,
              recentPath: path,
              recentView: recentView ?? undefined,
              savable: false,
            },
          }
        } catch (error) {
          return { error: noticeForOpenError(error), kind: "failed" }
        }
      }

      if (kind === "word") {
        if (batch.wordStopped) {
          return { error: null, kind: "failed" }
        }

        batch.wordAvailable ??= await invoke<boolean>(
          "word_conversion_available",
        ).catch(() => false)

        if (!batch.wordAvailable) {
          return { error: "wordUnavailable", kind: "failed" }
        }

        // An office suite may take minutes, holding every open queued behind
        // it; the corner says so and offers the way out.
        wordStopRef.current = false
        wordConvertingRef.current = true
        notices.raise({
          action: { kind: "wordConvertStop" },
          kind: "wordConverting",
          owner: workspaceOwner,
          values: { name: fileNameFromPath(path) },
        })
      }

      // A converted source opens like a created document: nothing on disk to
      // bind as a save destination or remember. Rust keeps the source only to
      // find this tab by when the same file is opened again.
      try {
        const override = e2eOverride("openConvertedFromPath")
        const document = override
          ? ((await override(path)) as PdfDocumentInfo)
          : await invoke<PdfDocumentInfo>("open_converted_from_path", { path })

        if (!mountedRef.current) {
          void invoke("close_pdf", { documentId: document.id }).catch(
            () => undefined,
          )
          return { error: null, kind: "failed" }
        }

        return {
          kind: "opened",
          tab: {
            convertedFrom: path,
            dirty: false,
            document,
            id: document.id,
            name: fileNameFromPath(path),
            path: "",
            saveAsDefaultName: pdfNameFromSource(path),
            savable: false,
          },
        }
      } catch (error) {
        return {
          error:
            kind === "word" && wordStopRef.current
              ? null
              : noticeForOpenError(error),
          kind: "failed",
        }
      } finally {
        if (kind === "word") {
          wordConvertingRef.current = false
          batch.wordStopped ||= wordStopRef.current
          notices.retract(workspaceOwner, ["wordConverting"])
        }
      }
    },
    [notices],
  )

  // A tab closed meanwhile leaves `tab` to append. The old tab's session
  // closes its document as it unmounts.
  const putInPlaceOf = useCallback(
    (documentId: number, tab: OpenTab) => {
      replaceTabs((current) =>
        current.some((item) => item.id === documentId)
          ? current.map((item) => (item.id === documentId ? tab : item))
          : [...current, tab],
      )
      notices.retract({ documentId, scope: "document" })

      if (activeIdRef.current === documentId) {
        activeIdRef.current = tab.id
        setActiveId(tab.id)
      }
    },
    [notices, replaceTabs],
  )

  // The file as it now stands, in the old tab's place; a failed read keeps
  // the old tab.
  const reloadTab = useCallback(
    async (
      documentId: number,
      batch: OpenBatch,
      confirm: () => Promise<boolean>,
    ): Promise<Reopened> => {
      const tab = tabsRef.current.find((item) => item.id === documentId)
      const kind = tab?.path
        ? "pdf"
        : tab?.convertedFrom
          ? classifyOpenSource(tab.convertedFrom)
          : null
      const source = tab?.path || tab?.convertedFrom

      if (!tab || !kind || !source) {
        return { error: null, id: tab ? documentId : null }
      }

      // Stored for the file, as a close stores it, for the reload to read back.
      await sessionRefs.current.get(documentId)?.rememberViewNow()

      const loaded = await loadSource(kind, source, batch)

      if (loaded.kind === "failed") {
        return { error: loaded.error, id: documentId }
      }

      if (!(await confirm())) {
        void invoke("close_pdf", { documentId: loaded.tab.id }).catch(
          () => undefined,
        )
        return { error: null, id: documentId }
      }

      putInPlaceOf(documentId, loaded.tab)

      return { error: null, id: loaded.tab.id }
    },
    [loadSource, putInPlaceOf],
  )

  // A document other files were added to was saved as a file of its own: the
  // tab shows that file as a reopen would, one file whose bookmarks name the
  // parts. The old document goes with its history, as the reader agreed.
  const reopenCombinedTab = useCallback(
    (documentId: number) => {
      void runOpenBatch(async () => {
        const batch: OpenBatch = { wordAvailable: null, wordStopped: false }
        // A tab closed while the file was read stays closed.
        const reopened = await reloadTab(documentId, batch, () =>
          Promise.resolve(tabsRef.current.some((tab) => tab.id === documentId)),
        )

        if (reopened.error && mountedRef.current) {
          notices.raise({ kind: reopened.error, owner: workspaceOwner })
        }
      })
    },
    [notices, reloadTab, runOpenBatch],
  )

  // Save as A4's copy, written and bound to its file, takes the tab's place:
  // the tab shows that file as an open of it would, the old document closing
  // with its session.
  const tabHasUnsavedWork = useCallback(
    (documentId: number) =>
      sessionRefs.current.get(documentId)?.hasUnsavedWorkNow() ??
      tabsRef.current.some((tab) => tab.id === documentId && tab.dirty),
    [],
  )

  // A document with unsaved work keeps its tab: the copy cannot carry its
  // annotations, so they would be gone for good. The copy opens beside it.
  const replaceWithWritten = useCallback(
    (documentId: number, document: PdfDocumentInfo) => {
      const path = document.path

      if (!mountedRef.current || !path) {
        void invoke("close_pdf", { documentId: document.id }).catch(() => undefined)
        return
      }

      const tab: OpenTab = {
        dirty: false,
        document,
        id: document.id,
        name: fileNameFromPath(path),
        path,
        recentPath: path,
        savable: false,
      }

      if (tabHasUnsavedWork(documentId)) {
        replaceTabs((current) => {
          const at = current.findIndex((item) => item.id === documentId)

          return at < 0
            ? [...current, tab]
            : [...current.slice(0, at + 1), tab, ...current.slice(at + 1)]
        })
        activateTab(tab.id)
      } else {
        putInPlaceOf(documentId, tab)
      }

      refreshRecentFiles()
    },
    [activateTab, putInPlaceOf, refreshRecentFiles, replaceTabs, tabHasUnsavedWork],
  )

  const tabName = useCallback(
    (documentId: number) =>
      tabsRef.current.find((tab) => tab.id === documentId)?.name ?? null,
    [],
  )
  const reopenPrompt = useReopenTab<OpenBatch>({
    hasUnsavedWork: tabHasUnsavedWork,
    reload: reloadTab,
    show: activateTab,
    tabName,
  })
  const reopenTab = reopenPrompt.reopen

  const openPaths = useCallback(
    (paths: string[], activate: "first" | "last" = "last") => {
      const sources = paths
        .map((path) => ({ kind: classifyOpenSource(path), path }))
        .filter(
          (source): source is { kind: OpenSourceKind; path: string } =>
            source.kind !== null,
        )

      if (sources.length === 0) {
        notices.raise({ kind: "invalidFile", owner: workspaceOwner })
        return Promise.resolve()
      }

      return runOpenBatch(async () => {
        const openedIds: number[] = []
        let firstError: NoticeKind | null = null
        const batch: OpenBatch = { wordAvailable: null, wordStopped: false }

        for (const { kind, path } of sources) {
          // A Stop is the way out of the queue, not out of one file: the
          // batch's later Word files would hold it just as long.
          if (kind === "word" && batch.wordStopped) {
            continue
          }

          // Independent edit histories over one file would overwrite each
          // other on save, however differently the file is named this time.
          const holder = await findOpenFile(
            path,
            tabsRef.current.map((tab) => tab.id),
          )

          if (holder.kind === "elsewhere") {
            notices.retract(workspaceOwner, openRefusals)
            continue
          }

          if (holder.kind === "here") {
            const reopened = await reopenTab(holder.documentId, batch)

            firstError ??= reopened.error

            if (reopened.id !== null) {
              openedIds.push(reopened.id)
            }

            // Only a tab gone meanwhile leaves the file to open as new.
            if (reopened.id !== null || reopened.error !== null) {
              continue
            }
          }

          const loaded = await loadSource(kind, path, batch)

          if (loaded.kind === "opened") {
            replaceTabs((current) => [...current, loaded.tab])
            openedIds.push(loaded.tab.id)
          } else {
            firstError ??= loaded.error
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
    [
      activateTab,
      loadSource,
      notices,
      reopenTab,
      replaceTabs,
      runOpenBatch,
    ],
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

  const signaturePrompt = useSignaturePrompt()
  const askSignatures = signaturePrompt.ask
  // A tab's pages going into another document, or into a new one of their own.
  const ensureSourceSignatures = useCallback(
    (documentId: number) =>
      sessionRefs.current.get(documentId)?.ensureSignatures("export") ?? true,
    [],
  )

  // The pages a drag let go of on the strip's open space: the app's own new
  // document, like a blank one, but holding work a close would lose.
  const openPagesAsDocument = useCallback(
    (carried: CarriedPages) => {
      // At the release, not when the open queue reaches it: the page numbers
      // name the source as it stands now, and could be stale by then. A
      // signature prompt in between is modal, so nothing renumbers them.
      const ready = ensureSourceSignatures(carried.sourceDocumentId)
      const extract = () =>
        invoke<PdfDocumentInfo>("extract_pdf_pages", {
          pageNumbers: carried.pages,
          sourceDocumentId: carried.sourceDocumentId,
        })
      const extracted =
        ready === true
          ? extract()
          : ready.then((allowed) => (allowed ? extract() : null))
      const sourceName = tabsRef.current.find(
        (tab) => tab.id === carried.sourceDocumentId,
      )?.name

      // Awaited in the batch; until then a refusal is not an unhandled one.
      void extracted.catch(() => undefined)

      return runOpenBatch(async () => {
        try {
          const document = await extracted

          if (!document) {
            return
          }

          if (!mountedRef.current) {
            void invoke("close_pdf", { documentId: document.id }).catch(
              () => undefined,
            )
            return
          }

          const stem = sourceName ? fileStem(sourceName) : ""
          const name = stem
            ? `${t("tabs.pagesFrom", { name: stem })}.pdf`
            : t("menu.untitled")
          const tab: OpenTab = {
            dirty: true,
            document,
            id: document.id,
            initialSaveRequired: true,
            name,
            path: "",
            saveAsDefaultName: name,
            savable: false,
          }

          replaceTabs((current) => [...current, tab])
          activateTab(tab.id)
          notices.retract(workspaceOwner, openRefusals)
        } catch {
          notices.raise({ kind: "extractFailed", owner: workspaceOwner })
        }
      })
    },
    [
      activateTab,
      ensureSourceSignatures,
      notices,
      replaceTabs,
      runOpenBatch,
      t,
    ],
  )

  // The pages are about to land in this tab's column, so its sidebar shows
  // pages, whichever panel the window last chose. The choice is stored, so it
  // is changed only where the tab would show bookmarks instead.
  const carryIntoTab = useCallback(
    (tabId: number) => {
      const outline = tabsRef.current.find((tab) => tab.id === tabId)?.document.outline

      if (sidebar.panel !== "thumbnails" && (outline?.length ?? 0) > 0) {
        sidebar.setPanel("thumbnails")
      }

      activateTab(tabId)
    },
    [activateTab, sidebar],
  )

  const canAppendToTab = useCallback(
    (tabId: number) => sessionRefs.current.get(tabId)?.canTakePagesNow() ?? false,
    [],
  )

  // Said in the corner: the tab that took the pages, or refused them, is
  // usually not on screen.
  const appendPagesToTab = useCallback(
    (tabId: number, carried: CarriedPages) => {
      const landing = sessionRefs.current.get(tabId)?.appendCarriedPages(carried) ?? null
      const name = tabsRef.current.find((tab) => tab.id === tabId)?.name

      if (!landing) {
        if (name) {
          notices.raise({
            kind: "pagesAppendBusy",
            owner: workspaceOwner,
            values: { name },
          })
        }

        return null
      }

      void landing.then(
        (landed) => {
          if (landed && name) {
            notices.raise({
              kind: "pagesAppended",
              owner: workspaceOwner,
              values: { count: carried.pages.length, name },
            })
          }
        },
        () => undefined,
      )

      return landing
    },
    [notices],
  )

  const pageCarry = usePageCarry({
    activeIdRef,
    canAppend: canAppendToTab,
    onActivate: carryIntoTab,
    onAppend: appendPagesToTab,
    onNewDocument: openPagesAsDocument,
  })

  const openNewWindow = useCallback(() => {
    void invoke("open_new_window").catch(() =>
      notices.raise({ kind: "newWindowFailed", owner: workspaceOwner }),
    )
  }, [notices])

  // Only files a document can take its pages from; anything else is said to be
  // no such file, rather than opened as a tab the reader did not drop it as.
  const addDroppedFiles = useCallback(
    (paths: string[], point: { x: number; y: number }) => {
      const sources = paths.filter((path) => isSourcePath(path, wordConversionAvailable()))

      if (sources.length === 0) {
        notices.raise({ kind: "invalidFile", owner: workspaceOwner })
        return
      }

      const shown = activeIdRef.current

      if (shown !== HOME_TAB_ID) {
        sessionRefs.current.get(shown)?.addFiles(sources, point)
      }
    },
    [notices],
  )
  const hasUnsavedWorkNow = useCallback(
    () =>
      tabsRef.current.some((tab) =>
        sessionRefs.current.get(tab.id)?.hasUnsavedWorkNow() ?? tab.dirty,
      ),
    [],
  )
  const hasUnsavedChangesNow = useCallback(
    (ids: number[]) =>
      ids.some((id) => {
        const session = sessionRefs.current.get(id)

        return session
          ? session.hasUnsavedChangesNow()
          : tabsRef.current.some((tab) => tab.id === id && tab.dirty)
      }),
    [],
  )
  const appUpdate = useAppUpdate(hasUnsavedWorkNow)

  const quitNow = useCallback(() => {
    const override = e2eOverride("quitApp")

    void (override ? override() : invoke("quit_app")).catch(() => undefined)
  }, [])

  // One question for every window, asked here: the reader is in this one.
  const requestQuit = useCallback(async () => {
    if (quitCheckRef.current) {
      return
    }

    quitCheckRef.current = true

    try {
      const elsewhere = await unsavedWorkElsewhere()

      if (elsewhere || hasUnsavedWorkNow()) {
        askToClose({
          changes: hasUnsavedChangesNow(tabsRef.current.map((tab) => tab.id)),
          elsewhere,
          kind: "quit",
        })
      } else {
        quitNow()
      }
    } finally {
      quitCheckRef.current = false
    }
  }, [askToClose, hasUnsavedChangesNow, hasUnsavedWorkNow, quitNow])
  const {
    confirmingInstall, setConfirmingInstall, installFailed, status, visible,
  } = appUpdate
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
  }, [notices, update])

  useEffect(() => {
    // About can install even after the notification was dismissed. Only a
    // change to the package's readiness should close its confirmation.
    if (status.state !== "ready") {
      setConfirmingInstall(false)
    }
  }, [setConfirmingInstall, status.state])

  // A Stop pressed before the backend has listed the conversion finds nothing
  // to stop, so it asks again until one listens or the conversion is over.
  const stopWordOpen = useCallback(async () => {
    const override = e2eOverride("cancelWordOpen")

    while (wordConvertingRef.current) {
      const listened = await (
        override ? override() : invoke<boolean>("cancel_word_open")
      ).catch(() => false)

      if (listened) {
        return
      }

      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }, [])

  const runNoticeAction = useCallback(
    (notice: Notice) => {
      const kind = notice.action?.kind

      if (kind === "updateDownload" || kind === "updateRetry") {
        appUpdate.download()
      } else if (kind === "updateInstall") {
        appUpdate.requestInstall()
      } else if (kind === "noteFont" && notice.owner.scope === "document") {
        sessionRefs.current.get(notice.owner.documentId)?.fetchNoteFont()
      } else if (
        kind === "layerStop" &&
        !notice.action?.busy &&
        notice.owner.scope === "document"
      ) {
        notices.raise({ ...notice, action: { busy: true, kind } })
        sessionRefs.current.get(notice.owner.documentId)?.stopLayerWork()
      } else if (kind === "wordConvertStop" && !notice.action?.busy) {
        wordStopRef.current = true
        notices.raise({ ...notice, action: { busy: true, kind } })
        void stopWordOpen()
      } else if (kind === "fileAddStop" && !notice.action?.busy) {
        // Stops the window's conversion, whichever document asked for it.
        notices.raise({ ...notice, action: { busy: true, kind } })
        void invoke("cancel_word_conversion").catch(() => undefined)
      }
    },
    [appUpdate, notices, stopWordOpen],
  )

  // Two notices own their dismissal: the update, waved away while it says the
  // same thing, and the font offer, which in a viewer tab drops its held edit.
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
            filterLabel: t("viewer.openFilter"),
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
        askToClose({
          changes: hasUnsavedChangesNow([documentId]),
          documentId,
          kind: "tab",
        })
      } else {
        void removeTabNow(documentId)
      }
    },
    [askToClose, hasUnsavedChangesNow, removeTabNow],
  )

  const removeTabsNow = useCallback(
    (documentIds: number[], anchorId: number) => {
      const closing = new Set(documentIds)
      // Captured before the panels go, as `removeTabNow` captures its own.
      const remembered = Promise.all(
        documentIds.map(
          (id) =>
            sessionRefs.current.get(id)?.rememberViewNow() ?? Promise.resolve(),
        ),
      ).then(() => undefined)
      const next = replaceTabs((existing) =>
        existing.filter((tab) => !closing.has(tab.id)),
      )

      for (const id of documentIds) {
        notices.retract({ documentId: id, scope: "document" })
      }

      const currentActiveId = activeIdRef.current

      if (currentActiveId !== HOME_TAB_ID && closing.has(currentActiveId)) {
        const nextActiveId = next.some((tab) => tab.id === anchorId)
          ? anchorId
          : HOME_TAB_ID

        activeIdRef.current = nextActiveId
        setActiveId(nextActiveId)
      }

      focusWorkspaceTarget(activeIdRef.current, true)

      return remembered
    },
    [notices, replaceTabs],
  )

  // One question for the lot, as closing all asks it.
  const requestCloseOthers = useCallback(
    (anchorId: number, which: OtherTabs) => {
      const documentIds = otherTabIds(
        tabsRef.current.map((tab) => tab.id),
        anchorId,
        which,
      )

      if (documentIds.length === 0) {
        return
      }

      const anyUnsaved = documentIds.some((id) =>
        sessionRefs.current.get(id)?.hasUnsavedWorkNow(),
      )

      if (anyUnsaved) {
        askToClose({
          anchorId,
          changes: hasUnsavedChangesNow(documentIds),
          documentIds,
          kind: "tabs",
        })
      } else {
        void removeTabsNow(documentIds, anchorId)
      }
    },
    [askToClose, hasUnsavedChangesNow, removeTabsNow],
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
      askToClose({
        changes: hasUnsavedChangesNow(tabsRef.current.map((tab) => tab.id)),
        kind: "all",
      })
    } else {
      void removeAllTabsNow()
    }
  }, [askToClose, hasUnsavedChangesNow, removeAllTabsNow])

  const closeNow = useCallback(
    (action: PendingClose) => {
      if (action.kind === "tab") {
        void removeTabNow(action.documentId)
      } else if (action.kind === "tabs") {
        void removeTabsNow(action.documentIds, action.anchorId)
      } else if (action.kind === "all") {
        void removeAllTabsNow()
      } else if (action.kind === "window") {
        void removeAllTabsNow().then(() => getCurrentWindow().destroy())
      } else {
        quitNow()
      }
    },
    [quitNow, removeAllTabsNow, removeTabNow, removeTabsNow],
  )

  // Each document with changes in turn, in front, so a Save As dialog is
  // plainly about the tab it shows; the first one not saved keeps them all.
  const saveThenClose = useCallback(
    async (action: PendingClose) => {
      const ids =
        action.kind === "tab"
          ? [action.documentId]
          : action.kind === "tabs"
            ? action.documentIds
            : tabsRef.current.map((tab) => tab.id)

      for (const id of ids) {
        const session = sessionRefs.current.get(id)

        if (!session?.hasUnsavedWorkNow()) {
          continue
        }

        // Not `activateTab`: the prompt just answered is still mounted, and
        // would hold the tab back until after its Save As had opened.
        showTab(id)

        if (!(await session.saveForClose())) {
          return
        }
      }

      closeNow(action)
    },
    [closeNow, showTab],
  )

  // The tab's own half of a move: what the strip shows and where it was being
  // read. The reading position reaches the recent list through the removal
  // below, exactly as a close leaves it.
  const detachTab = useCallback(
    (
      documentId: number,
      target:
        | { kind: "window"; label: string }
        | { kind: "new"; at: { x: number; y: number } | null },
    ) => {
      return runOpenBatch(async () => {
        const tab = tabsRef.current.find((item) => item.id === documentId)

        if (!tab) {
          return
        }

        const session = sessionRefs.current.get(documentId)
        const snapshot = session?.snapshotForMove() ?? null

        // Work still settling would change a document the move's history no
        // longer describes; a note draft's text lives nowhere but the session
        // it is open in. Either way the tab waits where it is.
        if (!snapshot || "blocked" in snapshot) {
          notices.raise({
            kind: snapshot?.blocked === "note" ? "tabMoveNoteOpen" : "tabMoveBusy",
            owner: workspaceOwner,
          })
          return
        }

        const payload: MovedTabPayload = {
          convertedFrom: tab.convertedFrom,
          document: snapshot.document,
          dirty: tab.dirty,
          name: tab.name,
          path: tab.path,
          recentPath: tab.recentPath,
          recentView: snapshot.recentView ?? tab.recentView,
          saveAsDefaultName: tab.saveAsDefaultName,
          savable: tab.savable,
          saveRequired: snapshot.saveRequired,
          seed: snapshot.seed,
        }

        try {
          if (target.kind === "window") {
            const override = e2eOverride("moveDocument")

            if (override) {
              await override({
                documentId,
                destLabel: target.label,
                tab: payload,
              })
            } else {
              await moveTabToWindow(documentId, target.label, payload)
            }
          } else {
            const override = e2eOverride("moveDocumentNewWindow")

            if (override) {
              await override({ at: target.at, documentId, tab: payload })
            } else {
              await moveTabToNewWindow(documentId, payload, target.at)
            }
          }
        } catch {
          notices.raise({ kind: "tabMoveFailed", owner: workspaceOwner })
          return
        }

        // Ownership crossed in Rust before this: the unmounting session's own
        // close finds the document no longer this window's and leaves it be.
        removeTabNow(documentId)
      })
    },
    [notices, removeTabNow, runOpenBatch],
  )

  // The context menu's ask, which has no drop point to place a window at.
  const moveTabToNewWindowNow = useCallback(
    (documentId: number) => {
      void detachTab(documentId, { at: null, kind: "new" })
    },
    [detachTab],
  )

  const loadDragGeometry = useCallback(
    () =>
      Promise.all([
        getCurrentWindow().innerPosition(),
        getCurrentWindow().scaleFactor(),
        fetchWindowRects(),
      ])
        .then(([origin, scale, rects]) => ({
          origin: { x: origin.x, y: origin.y },
          rects,
          scale,
          selfLabel: getCurrentWindow().label,
        }))
        .catch(() => null),
    [],
  )

  const endTabHover = useCallback(() => {
    const was = hoverTargetRef.current

    hoverTargetRef.current = null
    dragGeometryRef.current = null

    if (was) {
      void emitTo(was, TAB_HOVER_EVENT, { over: false }).catch(
        () => undefined,
      )
    }
  }, [])

  // Follows a drag that has left the strip: the window under the pointer — if
  // any — is told so it can say the tab would land there. The dragging
  // window's own body is not one: the release there tears off, wherever an
  // older window is stacked behind it.
  const handleTabDragMove = useCallback(
    (name: string | null, point: { x: number; y: number }) => {
      if (name === null) {
        endTabHover()
        return
      }

      const geometry = (dragGeometryRef.current ??= loadDragGeometry())

      void geometry.then((loaded) => {
        // The drag ended before the screen answered, or another drag's
        // geometry replaced this one's.
        if (!loaded || dragGeometryRef.current !== geometry) {
          return
        }

        const over = windowAtPoint(
          globalPointFrom(point, loaded.origin, loaded.scale),
          loaded.rects,
          loaded.selfLabel,
        )
        const target = over && over.label !== loaded.selfLabel ? over.label : null

        if (target === hoverTargetRef.current) {
          return
        }

        const was = hoverTargetRef.current
        hoverTargetRef.current = target

        if (was) {
          void emitTo(was, TAB_HOVER_EVENT, { over: false }).catch(
            () => undefined,
          )
        }

        if (target) {
          void emitTo(target, TAB_HOVER_EVENT, {
            name,
            over: true,
          }).catch(() => undefined)
        }
      })
    },
    [endTabHover, loadDragGeometry],
  )

  // A release the strip did not keep: another window takes the tab, or one
  // opens where the reader let it go — including over this window's own body,
  // which is a tear-off and never a landing in a window behind it.
  const handleTabDropOutside = useCallback(
    (documentId: number, point: { x: number; y: number }) => {
      const geometry = (dragGeometryRef.current ??= loadDragGeometry())

      void geometry.then((loaded) => {
        // Unloaded geometry still decides: a new window opens by cascade
        // rather than the move being lost.
        if (!loaded) {
          void detachTab(documentId, { at: null, kind: "new" })
          return
        }

        const global = globalPointFrom(point, loaded.origin, loaded.scale)
        const over = windowAtPoint(global, loaded.rects, loaded.selfLabel)

        if (over && over.label !== loaded.selfLabel) {
          void detachTab(documentId, { kind: "window", label: over.label })
        } else {
          void detachTab(documentId, { at: global, kind: "new" })
        }
      })
    },
    [detachTab, loadDragGeometry],
  )

  // Save As binds the document to its destination; the tab follows with the
  // reader's name, the duplicate-open check's path, and the next suggestion.
  const updateSource = useCallback(
    (documentId: number, path: string, signatures: PdfDocumentInfo["signatures"]) => {
      const name = fileNameFromPath(path)

      replaceTabs((current) =>
        current.map((tab) =>
          tab.id === documentId
            ? {
                ...tab,
                document: { ...tab.document, signatures },
                name,
                path,
                recentPath: path,
                saveAsDefaultName: name,
              }
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

  // The window's one settings dialog: the menu that opens it moves between the
  // sidebar and the toolbar as the window narrows, and must not take it along.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance")
  const showSettings = useCallback((section: SettingsSection) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const menuActions: AppMenuActions = useMemo(
    () => ({
      canCloseAll: tabs.length > 0,
      canSaveAll,
      onCloseAll: requestCloseAll,
      onExit: () => void requestQuit(),
      onNew: () => void createDocument(),
      onNewWindow: openNewWindow,
      onOpen: () => void chooseFile(),
      onOpenRecent: (path) => void openPaths([path]),
      onRefreshRecent: refreshRecentFiles,
      onSaveAll: saveAllDocuments,
      onShowSettings: showSettings,
      recentFiles,
    }),
    [
      canSaveAll,
      chooseFile,
      createDocument,
      openNewWindow,
      openPaths,
      recentFiles,
      refreshRecentFiles,
      requestCloseAll,
      requestQuit,
      saveAllDocuments,
      showSettings,
      tabs.length,
    ],
  )

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

  // Only a document tab's pages zoom; a dialog in front takes the keys from them.
  useEffect(() => {
    const zoomDocument = (event: KeyboardEvent) => {
      const action = event.defaultPrevented ? null : zoomShortcut(event, macOS)

      if (!action) {
        return
      }

      event.preventDefault()

      if (hasLayerOverWorkspace()) {
        return
      }

      const tabId = activeIdRef.current
      if (tabId !== HOME_TAB_ID) {
        sessionRefs.current.get(tabId)?.zoom(action)
      }
    }

    document.addEventListener("keydown", zoomDocument)

    return () => document.removeEventListener("keydown", zoomDocument)
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
      // the page selection set at the repeat rate for nothing.
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
      { run: () => activeSession()?.saveFromKey(), shortcut: shortcuts.save },
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
      {
        fieldFirst: true,
        run: () => activeSession()?.redo(),
        shortcut: shortcuts.redo,
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
    // The OS reports drags of anything at all, and one naming no file has
    // nothing to open: left alone rather than met with a drop target and an error.
    let namesNoFile = false
    const windows = isWindows()
    // A document's pages, down the sidebar or across the grid, are a target
    // of their own while it shows: files let go there are added to it.
    const cssPoint = (position: { x: number; y: number }) =>
      dropPointInCss(position, windows, window.devicePixelRatio)
    const pagesDropAt = (position: { x: number; y: number }): PagesDrop => {
      if (activeIdRef.current === HOME_TAB_ID || !pagesShown()) {
        return null
      }

      return overPages(cssPoint(position)) ? "over" : "offered"
    }

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        // A drop naming no file ends its drag the way a `leave` does: nothing
        // was ever offered, so nothing lands.
        if (
          event.payload.type === "leave" ||
          (event.payload.type === "drop" && event.payload.paths.length === 0)
        ) {
          namesNoFile = false
          setIsDragging(false)
          setPagesDrop(null)
          setPagesDropPoint(null)
          return
        }

        if (event.payload.type === "drop") {
          namesNoFile = false
          setIsDragging(false)
          setPagesDrop(null)
          setPagesDropPoint(null)

          // Opened as tabs, unless let go on the pages, where they join them.
          if (pagesDropAt(event.payload.position) === "over") {
            addDroppedFiles(event.payload.paths, cssPoint(event.payload.position))
          } else {
            void openPaths(event.payload.paths, "first")
          }

          return
        }

        // Only `enter` names the files; `over` carries a position and nothing else.
        if (event.payload.type === "enter") {
          namesNoFile = event.payload.paths.length === 0
        }

        if (!namesNoFile) {
          const drop = pagesDropAt(event.payload.position)

          setIsDragging(true)
          setPagesDrop(drop)
          setPagesDropPoint(drop === "over" ? cssPoint(event.payload.position) : null)
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
  }, [addDroppedFiles, openPaths])

  // A double-clicked file reaches the app before this workspace exists, so
  // Rust holds it: the event carries no paths, only that a take will find some.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    const openWhatTheOsNamed = () =>
      invoke<string[]>("take_launch_files")
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

    // Another window was asked to open a file a tab here holds: this window
    // shows it — reloaded, if something else has written the file since.
    void listen<number>(REOPEN_DOCUMENT_EVENT, (event) => {
      void runOpenBatch(async () => {
        const reopened = await reopenTab(event.payload, {
          wordAvailable: null,
          wordStopped: false,
        })

        if (!mountedRef.current) {
          return
        }

        if (reopened.id !== null) {
          activateTab(reopened.id)
        }

        if (reopened.error) {
          notices.raise({ kind: reopened.error, owner: workspaceOwner })
        }
      })
    }).then((stop) => {
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
  }, [activateTab, notices, reopenTab, runOpenBatch])

  // A tab another window sent here, as the launch flow hands its files over:
  // bound before the first take, so a tab arriving between the two finds a
  // listener already there rather than nobody.
  const takeArrivedTabs = useCallback(() => {
    return takeMovedTabs()
      .then((payloads) => {
        // Not conditioned on `cancelled`: a take that emptied the queue is
        // these tabs' only chance, as it is a launch's files'.
        if (payloads.length === 0) {
          return
        }

        void runOpenBatch(async () => {
          let arrived: number | null = null

          for (const payload of payloads) {
            // The move made this window the holder before the tab existed
            // here; only a take answered twice could say so, and it cannot.
            if (
              tabsRef.current.some((tab) => tab.id === payload.document.id)
            ) {
              continue
            }

            const tab: OpenTab = {
              convertedFrom: payload.convertedFrom,
              dirty: payload.dirty,
              document: payload.document,
              id: payload.document.id,
              initialSaveRequired: payload.saveRequired || undefined,
              movedSeed: payload.seed,
              name: payload.name,
              path: payload.path,
              recentPath: payload.recentPath,
              recentView: payload.recentView,
              saveAsDefaultName: payload.saveAsDefaultName,
              savable: payload.savable,
            }

            replaceTabs((current) => [...current, tab])
            arrived = tab.id
          }

          if (arrived !== null) {
            activateTab(arrived)
          }
        })
      })
      .catch(() => undefined)
  }, [activateTab, replaceTabs, runOpenBatch])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    void listen(TAB_ARRIVED_EVENT, () => void takeArrivedTabs()).then(
      (stop) => {
        if (cancelled) {
          stop()
          return
        }

        unlisten = stop
        // The window's own boot, or its reload: either way nothing announced
        // this take, and only doing it finds what waited through the page.
        void takeArrivedTabs()
      },
      // A subscription that never bound leaves the queue full all the same,
      // and taking it is what shows the moved tab this run.
      () => {
        if (!cancelled) {
          void takeArrivedTabs()
        }
      },
    )

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [takeArrivedTabs])

  // The dragged-over window's half of a hover: show it, and stop showing it —
  // a drag that ended with its window left this standing otherwise.
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    const clear = () => setTabHover(null)

    void listen<{
      name?: string
      over: boolean
    }>(TAB_HOVER_EVENT, (event) => {
      if (event.payload.over && typeof event.payload.name === "string") {
        setTabHover({ name: event.payload.name })
      } else {
        setTabHover(null)
      }
    }).then((stop) => {
      if (cancelled) {
        stop()
      } else {
        unlisten = stop
      }
    })

    // A real interaction here means no drag is held over another window
    // anymore, whatever became of the window that was dragging.
    window.addEventListener("pointerdown", clear)
    window.addEventListener("focus", clear)

    return () => {
      cancelled = true
      unlisten?.()
      window.removeEventListener("pointerdown", clear)
      window.removeEventListener("focus", clear)
    }
  }, [])

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
          askToClose({
            changes: hasUnsavedChangesNow(tabsRef.current.map((tab) => tab.id)),
            kind: "window",
          })
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
  }, [askToClose, hasUnsavedChangesNow, removeAllTabsNow])

  // Addressed to this window alone: a quit is asked about once, where the
  // reader is, and each window closes only itself.
  useEffect(() => {
    const label = getCurrentWindow().label
    let cancelled = false
    const stops: Array<() => void> = []
    const bind = (event: string, handler: () => void) =>
      void listen(event, handler, { target: label }).then((stop) => {
        if (cancelled) {
          stop()
        } else {
          stops.push(stop)
        }
      })

    bind(QUIT_REQUESTED_EVENT, () => void requestQuit())
    // Asked already, for every window: this one writes its reading positions
    // and goes, as a clean close of its own would.
    bind(QUIT_EVENT, () => {
      void removeAllTabsNow().then(() => getCurrentWindow().destroy())
    })

    return () => {
      cancelled = true
      stops.forEach((stop) => stop())
    }
  }, [removeAllTabsNow, requestQuit])

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  const homeActive = activeId === HOME_TAB_ID

  const shown = pendingClose ?? shownClose

  // Nothing here can save another window's work, nor keep work still running.
  const offerSave =
    shown !== null &&
    shown.changes &&
    !(shown.kind === "quit" && shown.elsewhere)

  const closeLoses = (action: PendingClose) =>
    action.changes || (action.kind === "quit" && action.elsewhere)

  const describeClose = (action: PendingClose) => {
    if (action.kind === "quit") {
      return action.elsewhere
        ? action.changes
          ? t("tabs.unsavedQuitHereAndElsewhereDescription")
          : t("tabs.unsavedQuitElsewhereDescription")
        : action.changes
          ? t("tabs.unsavedQuitDescription")
          : t("tabs.busyQuitDescription")
    }

    if (!action.changes) {
      return action.kind === "tab"
        ? t("tabs.busyTabDescription")
        : t("tabs.busyAllDescription")
    }

    return action.kind === "tab"
      ? t("tabs.unsavedTabDescription")
      : action.kind === "tabs"
        ? t("tabs.unsavedTabsDescription")
        : action.kind === "all"
          ? t("tabs.unsavedAllDescription")
          : t("tabs.unsavedWindowDescription")
  }

  const closeConfirmLabel = (action: PendingClose) => {
    if (action.kind === "quit") {
      return closeLoses(action) ? t("tabs.discardAndQuit") : t("tabs.stopAndQuit")
    }

    if (!closeLoses(action)) {
      return t("tabs.stopAndClose")
    }

    return action.kind === "tab"
      ? t("tabs.discardAndCloseTab")
      : action.kind === "tabs"
        ? t("tabs.discardAndCloseTabs")
        : action.kind === "all"
          ? t("tabs.discardAndCloseAll")
          : t("viewer.unsavedCloseConfirm")
  }

  // Read again on every visit, not just at startup: a file the list points at
  // may have been moved or deleted since, and the backend leaves those out.
  useEffect(() => {
    if (homeActive) {
      refreshRecentFiles()
    }
  }, [homeActive, refreshRecentFiles])

  const workspace = (
    <div
      className="app-surface h-svh overflow-hidden"
      data-sidebar={sidebar.mode}
      data-sidebar-width={sidebar.width === null ? undefined : ""}
      style={sidebarWidthStyle(sidebar.width, sidebar.reserved)}
    >
      {homeActive ? (
        // The document tools — bookmarks, view mode — have no document to act
        // on here, so the home toolbar carries only what still works.
        <>
          <AppSidebar macOS={macOS}>
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t("sidebar.noDocument")}
            </p>
          </AppSidebar>
          <ToolbarFrame
            active
            appMenu={<AppMenu {...menuActions} />}
            macOS={macOS}
          />
        </>
      ) : null}

      <HomePanel
        active={homeActive}
        onNew={() => void createDocument()}
        onOpenFile={() => void chooseFile()}
        onOpenRecent={(path) => void openPaths([path])}
        onRemoveRecent={removeRecent}
        onRevealRecent={revealRecent}
        opening={isOpening}
        recentFiles={recentFiles}
      />

      {tabs.map((tab) => (
        <DocumentSession
          active={tab.id === activeId}
          askSignatures={askSignatures}
          document={tab.document}
          ensureSourceSignatures={ensureSourceSignatures}
          fileName={tab.name}
          initialSaveRequired={tab.initialSaveRequired}
          initialRecentView={tab.recentView}
          // A moved tab keeps the view it was being read in even where no
          // recent view could be sampled for it — a background tab, a document
          // with no file of its own yet.
          initialViewMode={tab.movedSeed?.viewMode}
          key={tab.id}
          menu={menuActions}
          movedSeed={tab.movedSeed}
          notices={notices}
          onDirtyChange={updateDirty}
          onSavableChange={updateSavable}
          onCombinedSaved={reopenCombinedTab}
          onReplacedByFile={replaceWithWritten}
          onSourceChange={updateSource}
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
        appendOffer={pageCarry.appendOffer}
        armedTabId={pageCarry.armedTabId}
        newDocumentOffer={pageCarry.newDocumentOffer}
        onActivate={activateTab}
        onClose={requestCloseTab}
        onCloseAll={requestCloseAll}
        onCloseOthers={requestCloseOthers}
        onOpenFile={() => void chooseFile()}
        onReorder={reorderTabs}
        onTabDragMove={handleTabDragMove}
        onTabDropOutside={handleTabDropOutside}
        onMoveToNewWindow={moveTabToNewWindowNow}
        opening={isOpening}
        tabs={tabs}
      />

      {tabHover ? (
        // Never in the way: the drag's pointer is over another window, and
        // this only says where a release would leave its tab.
        <div
          className="pointer-events-none fixed inset-2 z-60 grid place-items-center rounded-2xl border-2 border-dashed border-primary/70 bg-background/90 backdrop-blur-sm"
          data-testid="tab-hover-overlay"
        >
          <div className="flex flex-col items-center text-center">
            <AppWindow className="mb-4 size-12" />
            <p className="text-lg font-semibold">
              {t("tabs.hoverTitle", { name: tabHover.name })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("tabs.hoverHint")}
            </p>
          </div>
        </div>
      ) : null}

      {isDragging ? (
        <div
          className={cn(
            "pointer-events-none fixed top-[calc(var(--toolbar-height)+var(--document-tabs-height)+0.75rem)] right-3 bottom-3 z-60 grid place-items-center rounded-2xl border-2 border-dashed backdrop-blur-sm",
            // Clear of the sidebar, docked or not, while its pages are a
            // target of their own.
            pagesDrop
              ? "left-[calc(var(--sidebar-width)+0.75rem)]"
              : "left-[calc(var(--sidebar-inset)+0.75rem)]",
            pagesDrop === "over"
              ? "border-muted-foreground/30 bg-background/75 text-muted-foreground"
              : "border-primary/60 bg-background/90",
          )}
          data-testid="workspace-file-drop"
        >
          <div className="flex flex-col items-center text-center">
            <FileUp className="mb-4 size-12" />
            <p className="text-lg font-semibold">
              {t("tabs.dropNow")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("tabs.dropHint")}
            </p>
          </div>
        </div>
      ) : null}

      <ReloadPrompt
        name={reopenPrompt.name}
        onAnswer={reopenPrompt.answer}
        open={reopenPrompt.open}
      />
      <SignaturePrompt
        forRest={signaturePrompt.forRest}
        onAnswer={signaturePrompt.answer}
        onForRestChange={signaturePrompt.changeForRest}
        onRememberChange={signaturePrompt.changeRemember}
        open={signaturePrompt.open}
        remember={signaturePrompt.remember}
        request={signaturePrompt.request}
      />

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

      <SettingsDialog
        onOpenChange={setSettingsOpen}
        onSectionChange={setSettingsSection}
        open={settingsOpen}
        section={settingsSection}
      />

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingClose(null)
          }
        }}
        open={pendingClose !== null}
      >
        <AlertDialogContent size={offerSave ? "default" : "sm"}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {shown && !closeLoses(shown)
                ? t("tabs.busyTitle")
                : t("viewer.unsavedTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {shown ? describeClose(shown) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("viewer.unsavedCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingClose
                setPendingClose(null)

                if (action) {
                  closeNow(action)
                }
              }}
              variant={offerSave ? "destructive" : "default"}
            >
              {shown ? closeConfirmLabel(shown) : null}
            </AlertDialogAction>
            {offerSave ? (
              <AlertDialogAction
                onClick={() => {
                  const action = pendingClose
                  setPendingClose(null)

                  if (action) {
                    void saveThenClose(action)
                  }
                }}
              >
                {t("tabs.saveBeforeClose")}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )

  return (
    <AppUpdateContext.Provider value={appUpdate}>
      <SidebarContext.Provider value={sidebar}>
        <PagesDropContext.Provider value={pagesDrop}>
          <PageCarryContext.Provider value={pageCarry.carry}>
            {workspace}
          </PageCarryContext.Provider>
        </PagesDropContext.Provider>
      </SidebarContext.Provider>
    </AppUpdateContext.Provider>
  )
}
