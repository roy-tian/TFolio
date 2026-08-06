import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  BookCopy,
  Bookmark,
  FileUp,
  LoaderCircle,
  RotateCw,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { BookmarkSidebar } from "@/components/BookmarkSidebar"
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
import { PageNumbersDialog } from "@/components/PageNumbersDialog"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { TextNoteEditor } from "@/components/TextNoteEditor"
import { WatermarkDialog } from "@/components/WatermarkDialog"
import { SettingsDialog } from "@/components/SettingsDialog"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { ZoomControls } from "@/components/ZoomControls"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { useAnnotations } from "@/hooks/useAnnotations"
import { useCurrentPageTracker } from "@/hooks/useCurrentPageTracker"
import { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import { useHighlightTool } from "@/hooks/useHighlightTool"
import { useRectTool } from "@/hooks/useRectTool"
import { usePageNumbers } from "@/hooks/usePageNumbers"
import { useTextNoteTool } from "@/hooks/useTextNoteTool"
import { useWatermark } from "@/hooks/useWatermark"
import { useZoom } from "@/hooks/useZoom"
import {
  defaultHighlightColor,
  defaultRectStyle,
  defaultTextNoteStyle,
  HIGHLIGHT_OPACITY,
  readStoredHighlightColor,
  readStoredRectStyle,
  readStoredTextNoteStyle,
  storeHighlightColor,
  storeRectStyle,
  storeTextNoteStyle,
} from "@/lib/annotationStyles"
import {
  movesPages,
  planDeletePages,
  planInsertBlankPage,
  type AnnotationCommand,
  type AnnotationHistory,
  type HexColor,
  type RectStyle,
  type TextNoteStyle,
} from "@/lib/annotations"
import { e2eOverride, isE2eBuild } from "@/lib/e2e"
import {
  documentPageCount,
  fileBlockPages,
  fileRanges,
  hasMergedPages,
  nextParityOp,
  padPagePositions,
  type FileRange,
  type InitialFile,
} from "@/lib/fileRanges"
import {
  fileNameFromPath,
  isPdfPath,
  type PdfDocumentInfo,
  type PdfExportOutcome,
  type PdfStructureUpdate,
} from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import {
  defaultViewMode,
  readStoredViewMode,
  storeViewMode,
  type ViewMode,
} from "@/lib/viewMode"
import { cn } from "@/lib/utils"
import { CONTENT_PADDING_X, CONTENT_PADDING_Y } from "@/lib/zoom"

type ViewerError =
  | "annotateFailed"
  | "exportFailed"
  | "fileTooLarge"
  | "invalidFile"
  | "openFailed"
  | "saveFailed"
  | null

/** What is waiting on the reader's leave to discard unsaved marks. */
type PendingAction = { kind: "open"; path: string } | { kind: "close" }

function closePdf(documentId: number) {
  void invoke("close_pdf", { documentId }).catch(() => undefined)
}

export default function App() {
  const { t } = useTranslation()
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentInfo | null>(null)
  const [fileName, setFileName] = useState("")
  // The document as it was opened, before any merges — the initial file range's
  // name and page count, which the command history alone cannot recover. Fixed
  // for the session; a new open replaces it.
  const [initialFile, setInitialFile] = useState<InitialFile | null>(null)
  // Whether the reader has turned smart parity padding on. Kept as intent rather
  // than derived from the pads present, because a document that happens to need
  // no pad right now is indistinguishable from one with the feature off — yet a
  // later merge must still know to reconcile. Session state, reset on open, so
  // it never drifts across documents.
  const [parityEnabled, setParityEnabled] = useState(false)
  const [currentPage, setCurrentPage] = useState(0)
  const [pageInput, setPageInput] = useState("0")
  const [rotation, setRotation] = useState(0)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [viewerError, setViewerError] = useState<ViewerError>(null)
  const [viewerWidth, setViewerWidth] = useState(0)
  const [viewerHeight, setViewerHeight] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => readStoredViewMode() ?? defaultViewMode,
  )
  const [activeTool, setActiveTool] = useState<AnnotationTool>(null)
  const [highlightColor, setHighlightColor] = useState<HexColor>(
    () => readStoredHighlightColor() ?? defaultHighlightColor,
  )
  const [rectStyle, setRectStyle] = useState<RectStyle>(
    () => readStoredRectStyle() ?? defaultRectStyle,
  )
  const [textNoteStyle, setTextNoteStyle] = useState<TextNoteStyle>(
    () => readStoredTextNoteStyle() ?? defaultTextNoteStyle,
  )
  // A drop, a picked file, or a window close waiting for the reader to confirm
  // that it may discard unsaved marks; null when nothing is pending.
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const viewerRef = useRef<HTMLElement>(null)
  const documentRef = useRef<PdfDocumentInfo | null>(null)
  // Read by the parity reconcile, which runs after an awaited file operation —
  // past the point the rendered `initialFile` can be trusted in a closure.
  const initialFileRef = useRef<InitialFile | null>(null)
  // The parity intent, read by the same post-await reconcile.
  const parityEnabledRef = useRef(false)
  // Files dropped alongside the first, waiting for that first to open before
  // they can be merged (the merge needs the new document's id, which reaches
  // the hook only on the next render). Tagged with the id they belong to.
  const pendingMergeRef = useRef<{ documentId: number; paths: string[] } | null>(
    null,
  )
  const requestIdRef = useRef(0)
  const pendingScrollPageRef = useRef<number | null>(null)

  // The thumbnail grid and the files view give every cell the same width
  // whatever the page, so neither has a single scale to report or anything for a
  // zoom to act on. The controls are absent there rather than disabled: disabled
  // reads as "not just now", which is what an unopened document means, and it
  // would leave the readout showing a figure that describes nothing on screen.
  const zoomApplies = viewMode === "single" || viewMode === "book"
  const zoom = useZoom({
    contentHeight: Math.max(0, viewerHeight - CONTENT_PADDING_Y),
    contentWidth: Math.max(0, viewerWidth - CONTENT_PADDING_X),
    currentPage,
    disabled: !pdfDocument || !zoomApplies,
    pages: pdfDocument?.pages ?? [],
    rotation,
    viewMode,
    viewerRef,
  })
  const resetZoomToDefault = zoom.resetToDefault

  // Every drawing tool needs a page under the pointer, which neither the
  // thumbnail grid nor the files view shows. Only undo, redo, watermark, and
  // export act on the document rather than a page, so they stay.
  const drawingApplies = viewMode === "single" || viewMode === "book"
  // In the thumbnail grid a click is a selection, so the grid doubles as the
  // page-editing surface; leaving it clears what was chosen.
  const thumbnailSelection = useThumbnailSelection({
    active: viewMode === "thumbnail",
  })
  const clearThumbnailSelection = thumbnailSelection.clear
  const annotations = useAnnotations({
    documentId: pdfDocument?.id,
    onAnnotateError: useCallback(() => setViewerError("annotateFailed"), []),
    onExportError: useCallback(() => setViewerError("exportFailed"), []),
    // A byte-opened document adopts its first export's destination as its
    // source, which is when `path` appears and the save key comes alive.
    onExported: useCallback((documentId: number, outcome: PdfExportOutcome) => {
      if (!outcome.savedToSource) {
        return
      }

      const current = documentRef.current

      if (!current || current.id !== documentId || current.path === outcome.path) {
        return
      }

      const next = { ...current, path: outcome.path }
      documentRef.current = next
      setPdfDocument(next)
    }, []),
    onSaveError: useCallback(() => setViewerError("saveFailed"), []),
    // A structure command moved the page list under everything keyed by page
    // number, so the metadata is replaced wholesale and every position-derived
    // state — the current page, the selection — is brought back into range.
    onStructureChange: useCallback(
      (documentId: number, update: PdfStructureUpdate) => {
        const current = documentRef.current

        if (!current || current.id !== documentId) {
          return
        }

        const next = {
          ...current,
          numPages: update.numPages,
          outline: update.outline,
          pages: update.pages,
        }

        documentRef.current = next
        setPdfDocument(next)
        setCurrentPage((page) =>
          Math.min(Math.max(page, 1), Math.max(1, update.numPages)),
        )
        clearThumbnailSelection()
      },
      [clearThumbnailSelection],
    ),
    // A toast that outlives what it describes would sit over every mark the
    // reader went on to make successfully.
    onSuccess: useCallback(() => setViewerError(null), []),
  })
  const resetAnnotations = annotations.reset
  const watermark = useWatermark({
    activeConfig: annotations.watermarkConfig,
    documentId: pdfDocument?.id,
    onSet: annotations.setWatermark,
    pageCount: pdfDocument?.numPages ?? 0,
  })
  const pageNumbers = usePageNumbers({
    activeConfig: annotations.pageNumbersConfig,
    documentId: pdfDocument?.id,
    onSet: annotations.setPageNumbers,
    pageCount: pdfDocument?.numPages ?? 0,
  })

  const textSelectionDragging = useHighlightTool({
    active: Boolean(pdfDocument) && drawingApplies && activeTool === "highlight",
    color: highlightColor,
    onCommit: annotations.commit,
    opacity: HIGHLIGHT_OPACITY,
    pages: pdfDocument?.pages ?? [],
    rotation,
    selectable:
      Boolean(pdfDocument) &&
      drawingApplies &&
      (activeTool === null || activeTool === "highlight"),
    viewerRef,
  })

  const drawingRect = drawingApplies && activeTool === "rect"
  const rectDraft = useRectTool({
    active: Boolean(pdfDocument) && drawingRect,
    onCommit: annotations.commit,
    pages: pdfDocument?.pages ?? [],
    rotation,
    style: rectStyle,
    viewerRef,
  })

  const drawingTextNote = drawingApplies && activeTool === "textNote"
  const textNote = useTextNoteTool({
    active: Boolean(pdfDocument) && drawingTextNote,
    onCommit: annotations.commit,
    pages: pdfDocument?.pages ?? [],
    rotation,
    style: textNoteStyle,
    viewerRef,
  })

  const changeHighlightColor = useCallback((color: HexColor) => {
    setHighlightColor(color)
    storeHighlightColor(color)
  }, [])

  const changeRectStyle = useCallback((style: RectStyle) => {
    setRectStyle(style)
    storeRectStyle(style)
  }, [])

  const changeTextNoteStyle = useCallback((style: TextNoteStyle) => {
    setTextNoteStyle(style)
    storeTextNoteStyle(style)
  }, [])

  // The destination dialog is the backend's own, so this only says *that* an
  // export happens; `onExportError` reports a failed write.
  const exportPdf = useCallback(async () => {
    if (!pdfDocument) {
      return
    }

    await annotations.exportCopy(
      t("annotate.exportDefaultName"),
      t("annotate.exportFilter"),
    )
  }, [annotations, pdfDocument, t])

  const loadPdfFromPath = useCallback(async (path: string, mergeTail: string[] = []) => {
    if (!isPdfPath(path)) {
      setViewerError("invalidFile")
      return
    }

    const requestId = ++requestIdRef.current
    setViewerError(null)
    setIsLoading(true)
    setFileName(fileNameFromPath(path))
    setCurrentPage(0)
    setRotation(0)
    resetZoomToDefault()
    resetAnnotations()
    clearThumbnailSelection()
    setActiveTool(null)
    setBookmarksOpen(false)
    setPdfDocument(null)
    setInitialFile(null)
    initialFileRef.current = null
    setParityEnabled(false)
    parityEnabledRef.current = false

    const previousDocument = documentRef.current
    documentRef.current = null

    if (previousDocument) {
      closePdf(previousDocument.id)
    }

    try {
      const openDocument = e2eOverride("openPdfFromPath")
      const nextDocument = openDocument
        ? ((await openDocument(path)) as PdfDocumentInfo)
        : await invoke<PdfDocumentInfo>("open_pdf_from_path", { path })

      if (requestId !== requestIdRef.current) {
        closePdf(nextDocument.id)
        return
      }

      documentRef.current = nextDocument
      setPdfDocument(nextDocument)
      // The file every later merge is measured against. Recorded here, at the
      // one moment it is the whole document, and never touched by a structure
      // edit again.
      const opened = { name: fileNameFromPath(path), pageCount: nextDocument.numPages }
      initialFileRef.current = opened
      setInitialFile(opened)
      setCurrentPage(1)
      // Files dropped alongside the first are merged once this document reaches
      // the hook (its id only arrives on the next render). Keyed to *this*
      // document's id so a superseded open — or a later, unrelated one — never
      // pulls these paths into the wrong document.
      if (mergeTail.length > 0) {
        pendingMergeRef.current = { documentId: nextDocument.id, paths: mergeTail }
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setFileName("")
        // The size ceiling is the backend's now — a path says nothing about
        // its file until the backend has looked. The substring is a contract:
        // `size_limit_error` in `pdfium/mod.rs` is the one place the message
        // is worded, and it stays in step with this match.
        setViewerError(
          String(error).includes("MiB limit") ? "fileTooLarge" : "openFailed",
        )
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [clearThumbnailSelection, resetAnnotations, resetZoomToDefault])

  /**
   * Every way in — the picker and a drop — funnels through here, so unsaved
   * marks always get their confirmation before the document under them goes.
   * Dirtiness is asked of the queue's own history, not the rendered state,
   * which can lag it by a render — exactly when a just-made mark would be
   * discarded without the question.
   */
  const requestOpenPath = useCallback(
    (path: string) => {
      if (!isPdfPath(path)) {
        setViewerError("invalidFile")
        return
      }

      if (documentRef.current && annotations.isDirtyNow()) {
        setPendingAction({ kind: "open", path })
        return
      }

      void loadPdfFromPath(path)
    },
    [annotations.isDirtyNow, loadPdfFromPath],
  )

  // The picker dialog is the backend's (`pick_pdf_path`), which also marks the
  // chosen path as one `open_pdf_from_path` may act on — the WebView cannot
  // conjure an approved path on its own.
  const chooseFile = useCallback(async () => {
    try {
      const pick = e2eOverride("pickPdfPath")
      const path = pick
        ? await pick()
        : await invoke<string | null>("pick_pdf_path", {
            filterLabel: t("annotate.exportFilter"),
          })

      if (typeof path === "string") {
        requestOpenPath(path)
      }
    } catch {
      setViewerError("openFailed")
    }
  }, [requestOpenPath, t])

  useEffect(() => {
    return () => {
      requestIdRef.current += 1

      if (documentRef.current) {
        closePdf(documentRef.current.id)
        documentRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    setPageInput(String(currentPage))
  }, [currentPage])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    let committedWidth = 0
    let committedHeight = 0

    const commitSize = (width: number, height: number) => {
      const roundedWidth = Math.round(width)
      const roundedHeight = Math.round(height)

      if (roundedWidth !== committedWidth) {
        committedWidth = roundedWidth
        setViewerWidth(roundedWidth)
      }

      if (roundedHeight !== committedHeight) {
        committedHeight = roundedHeight
        setViewerHeight(roundedHeight)
      }
    }

    commitSize(viewer.clientWidth, viewer.clientHeight)

    // Commit every observed size straight away. Layout — the grid's column
    // count, a fit mode's page scale — tracks the window in real time, while
    // the heavy PDFium renders stay throttled by the viewer's settled
    // `renderScale` debounce. ResizeObserver already batches to one callback
    // per frame, so a timer here would only add the lag of waiting for it.
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      commitSize(rect?.width ?? viewer.clientWidth, rect?.height ?? viewer.clientHeight)
    })
    resizeObserver.observe(viewer)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    storeViewMode(viewMode)
  }, [viewMode])

  // A structure edit reachable while a note is open must settle the draft
  // *before* it runs — a note is anchored by page number, which an edit can move
  // out from under it, and a note the reader finishes mid-edit would be dropped
  // by the in-flight-edit guard after the editor had already cleared its text.
  // A merge only appends, so the draft is committed onto its own unmoved page
  // (see mergePaths); undo and redo can move any page and can't take a note as
  // their target, so the uncommitted draft is discarded before the step (see the
  // toolbar). Both callbacks are stable.
  const cancelTextNote = textNote.cancel
  const commitTextNote = textNote.commit

  useCurrentPageTracker(
    viewerRef,
    pdfDocument?.id,
    viewMode,
    setCurrentPage,
    zoom.zoomPreviewing,
  )

  // Native drag-and-drop, because `dragDropEnabled` is on: Tauri consumes the
  // OS drag itself — HTML5 `dataTransfer` never sees these files — and it is
  // the only side of that trade that hands over real paths, which saving needs.
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
          // Every dropped PDF, not just the first: with a document open they are
          // all merged in; with none, the first opens and the rest merge after.
          handleDroppedPathsRef.current(event.payload.paths)
        }
      })
      .then((stop) => {
        // The effect may already be gone by the time the subscription resolves.
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

  // The close guard rides Tauri's close-requested event, not `beforeunload`:
  // wry never routes a window close through beforeunload, and on a reload
  // WebKitGTK waits for a confirm the embedder does not implement — wedging
  // the whole WebView. Registering this listener makes closing the app's job,
  // so the confirm dialog's close action must call `destroy()` itself. Not in
  // the e2e build: the harness tears sessions down with unsaved marks, and a
  // prompt nobody can answer would hang the suite.
  useEffect(() => {
    if (isE2eBuild) {
      return
    }

    let cancelled = false
    let unlisten: (() => void) | undefined

    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (documentRef.current && annotations.isDirtyNow()) {
          event.preventDefault()
          setPendingAction({ kind: "close" })
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
  }, [annotations.isDirtyNow])

  const scrollToPage = (
    pageNumber: number,
    behavior: ScrollBehavior = "smooth",
  ) => {
    const page = viewerRef.current?.querySelector<HTMLElement>(
      `[data-page-number="${pageNumber}"]`,
    )

    setCurrentPage(pageNumber)
    page?.scrollIntoView({ behavior, block: "start" })
  }

  // Double-clicking a thumbnail leaves the grid for the page itself; a single
  // click is selection now, so navigation moved to the second click.
  const openThumbnailPage = (pageNumber: number) => {
    pendingScrollPageRef.current = pageNumber
    setViewMode("single")
  }

  const selectThumbnailPage = (
    pageNumber: number,
    modifiers: SelectionModifiers,
  ) => {
    thumbnailSelection.select(pageNumber, modifiers)
  }

  // Every page-editing gesture carries page numbers read off the screen, so it
  // must not be queued behind a *page-shifting* edit — above all the multi-step
  // smart-parity reconcile — or it would land on the wrong page. The gesture is
  // dropped while such an edit is in flight; the pages the reader sees then
  // always match the numbers their next gesture names. An annotation in flight,
  // which shifts nothing, does not block editing. Checked off the ref so a
  // gesture in the same tick as the edit that started the churn is caught.
  const editingBusy = () => annotations.isStructureBusyNow()

  // After a page-level edit, bring the smart pads back to target if the feature
  // is on — a delete, insert, or reorder can push a file onto an even page just
  // as a file-level edit can, and the toggle staying on means the reader still
  // wants odd starts. Re-derived from the resulting layout, so a pad the edit
  // made surplus is removed and one it made necessary is added; a no-op when the
  // toggle is off or the layout already meets the target.
  const reconcileParityAfterEdit = () => {
    if (parityEnabledRef.current) {
      void applyParityTarget()
    }
  }

  // The x on a selected page takes the whole selection with it; on any other
  // page it takes that page alone. No confirmation — the delete is one undo
  // away, which a dialog would only pretend to improve on.
  const deleteThumbnailPage = (pageNumber: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    const pages = thumbnailSelection.selectedPages.has(pageNumber)
      ? [...thumbnailSelection.selectedPages]
      : [pageNumber]

    void annotations.deletePages(pages, pdfDocument.numPages).then(reconcileParityAfterEdit)
  }

  const insertBlankPage = (index: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.insertBlankPage(index, pdfDocument.numPages).then(reconcileParityAfterEdit)
  }

  const reorderPages = (order: number[]) => {
    if (editingBusy()) {
      return
    }

    void annotations.reorderPages(order).then(reconcileParityAfterEdit)
  }

  // The files are a positional accounting of the merged document's page ranges,
  // derived from the same command history the watermark config is (see
  // fileRanges). No document means no ranges.
  const ranges = useMemo(
    () => (initialFile ? fileRanges(annotations.history, initialFile) : []),
    [annotations.history, initialFile],
  )
  // Save is forbidden while another file's pages are actually present — matching
  // the backend guard, which tracks the merged page ids, not the mere history of
  // a merge, and not a file card. A card can outlive its merged pages (a blank
  // inserted inside the file keeps the card but is this app's own page), so this
  // asks the backend's own question — does a merged page remain — rather than
  // "does a non-zero-id range exist", which would keep save disabled after the
  // last merged page is deleted while the backend already allows it.
  const hasMergedContent = useMemo(
    () => (initialFile ? hasMergedPages(annotations.history, initialFile) : false),
    [annotations.history, initialFile],
  )
  // A parity run — the toggle, or the reconcile a file operation triggers —
  // brings the whole document to its pad target through several queued edits.
  // Two runs overlapping would oscillate (one adding a pad the other removes),
  // so they are serialized: each waits for the previous to finish. A repeat run
  // whose target is already met is then simply a no-op.
  const parityChainRef = useRef<Promise<void>>(Promise.resolve())
  const runParity = useCallback((run: () => Promise<void>) => {
    const next = parityChainRef.current.then(run, run)
    parityChainRef.current = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }, [])

  // Steps the document one pad at a time toward what `choose` asks for, each op
  // re-derived *inside* the queue against the history it reached — so an
  // ordinary edit the reader slips in between steps is fully counted, never
  // shifting a position the loop had already fixed (the trap a precomputed
  // batch falls into). Highest position first, so an earlier op never moves a
  // later one's page. The bound guards against a pathological non-convergence.
  const runParitySteps = useCallback(
    (
      choose: (
        history: AnnotationHistory,
        total: number,
        initial: InitialFile,
      ) => { command: AnnotationCommand; history: AnnotationHistory } | null,
    ) =>
      runParity(async () => {
        for (let guard = 0; guard < 512; guard += 1) {
          const applied = await annotations.commitStructure((history) => {
            const initial = initialFileRef.current

            if (!initial) {
              return null
            }

            return choose(history, documentPageCount(history, initial), initial)
          })

          if (!applied) {
            return
          }
        }
      }),
    [annotations, runParity],
  )

  // Brings the smart pads to their target: one blank before every file that
  // would otherwise open on an even page, and away with any blank that serves
  // none. Each step is derived from the slots, so a stranded pad is counted.
  const applyParityTarget = useCallback(
    () =>
      runParitySteps((history, total, initial) => {
        const op = nextParityOp(history, initial)

        if (!op) {
          return null
        }

        return op.kind === "insert"
          ? planInsertBlankPage(history, op.at, total, true)
          : planDeletePages(history, [op.at], total)
      }),
    [runParitySteps],
  )

  // Removes every pad, found from the slots so a pad stranded from its file — a
  // pad-only run that shows no card — is cleared too, not left behind.
  const removeAllPads = useCallback(
    () =>
      runParitySteps((history, total, initial) => {
        const positions = padPagePositions(history, initial)

        return positions.length > 0
          ? planDeletePages(history, [Math.max(...positions)], total)
          : null
      }),
    [runParitySteps],
  )

  // Appends each PDF in turn — the queue keeps them in order — then, if the
  // smart pads were in place before, brings them back to target once so a newly
  // merged file gets its own pad without spending a reconcile per file.
  const mergePaths = useCallback(
    async (paths: string[]) => {
      // Finish any open note first, while the pages it is anchored to still sit
      // where the reader put them: the appends below (and the parity reconcile
      // after) leave those pages in place, so the committed note lands exactly
      // there, and is never left open to be dropped by the in-flight guard the
      // merges raise. A no-op when no note or an empty one is open.
      commitTextNote()

      for (const path of paths) {
        await annotations.mergeFile(path, fileNameFromPath(path))
      }

      if (parityEnabledRef.current) {
        await applyParityTarget()
      }
    },
    [annotations, applyParityTarget, commitTextNote],
  )

  const mergeFilePath = useCallback(
    (path: string) => {
      if (!isPdfPath(path)) {
        setViewerError("invalidFile")
        return
      }

      void mergePaths([path])
    },
    [mergePaths],
  )

  // The add-file button's picker, the same backend dialog `chooseFile` uses —
  // which also records the path as one a merge may act on.
  const chooseFileToMerge = useCallback(async () => {
    try {
      const pick = e2eOverride("pickPdfPath")
      const path = pick
        ? await pick()
        : await invoke<string | null>("pick_pdf_path", {
            filterLabel: t("annotate.exportFilter"),
          })

      if (typeof path === "string") {
        mergeFilePath(path)
      }
    } catch {
      setViewerError("annotateFailed")
    }
  }, [mergeFilePath, t])

  // Removing a whole file deletes its block — up to the next file's start, the
  // same span a card drag moves (`fileBlockPages`) — so its real pages, its
  // pads, and any pad stranded between it and the next file all go together,
  // none orphaned. The card disables this for the last remaining file.
  const deleteFile = useCallback(
    async (range: FileRange) => {
      if (!documentRef.current || annotations.isStructureBusyNow()) {
        return
      }

      const index = ranges.findIndex(
        (other) => other.id === range.id && other.start === range.start,
      )

      if (index < 0) {
        return
      }

      const total = documentRef.current.numPages

      await annotations.deletePages(fileBlockPages(ranges, index, total), total)

      if (parityEnabledRef.current) {
        await applyParityTarget()
      }
    },
    [annotations, applyParityTarget, ranges],
  )

  // A card drag reorders whole files; the pads travel with them, then reconcile
  // if enabled, since a new file order can change which files start even.
  const reorderFiles = useCallback(
    async (order: number[]) => {
      if (annotations.isStructureBusyNow()) {
        return
      }

      await annotations.reorderPages(order)

      if (parityEnabledRef.current) {
        await applyParityTarget()
      }
    },
    [annotations, applyParityTarget],
  )

  // The toggle carries the reader's intent, whether or not the current layout
  // happens to need a pad: enabling reconciles to the target (perhaps a no-op
  // right now), disabling clears every pad. The toggle sits in the main toolbar,
  // so it is reachable from the page view with a note open; settle the draft
  // first (like mergePaths), since enabling can insert a pad and disabling
  // remove one ahead of the note's page. Committed rather than dropped: the note
  // lands on its page and then travels with it through the pad shift, instead of
  // being left bound to a number the shift invalidates or refused by the
  // in-flight-edit guard the reconcile raises.
  const toggleParity = (next: boolean) => {
    commitTextNote()
    parityEnabledRef.current = next
    setParityEnabled(next)

    if (next) {
      void applyParityTarget()
    } else {
      void removeAllPads()
    }
  }

  // A no-document drop opens the first PDF, then merges the rest — passed to the
  // open itself, which records them against the document it produced so the
  // effect below merges them into that document and no other.
  const handleDroppedPaths = useCallback(
    (paths: string[]) => {
      const pdfPaths = paths.filter(isPdfPath)

      if (pdfPaths.length === 0) {
        setViewerError("invalidFile")
        return
      }

      if (documentRef.current) {
        // A document is open: every dropped PDF is appended, undoably — never a
        // replace, and so never the unsaved-changes guard.
        void mergePaths(pdfPaths)
        return
      }

      void loadPdfFromPath(pdfPaths[0]!, pdfPaths.slice(1))
    },
    [loadPdfFromPath, mergePaths],
  )

  useEffect(() => {
    const pending = pendingMergeRef.current

    if (pdfDocument && pending && pending.documentId === pdfDocument.id) {
      pendingMergeRef.current = null
      void mergePaths(pending.paths)
    }
  }, [pdfDocument, mergePaths])

  // The drop listener outlives every render, so it reads the latest handler
  // through a ref rather than resubscribing to the webview each time.
  const handleDroppedPathsRef = useRef(handleDroppedPaths)

  useEffect(() => {
    handleDroppedPathsRef.current = handleDroppedPaths
  }, [handleDroppedPaths])

  // Each mode stacks its pages to a different total height, and the viewer keeps
  // its scroll offset across the switch, so the old offset would land somewhere
  // unrelated. Remember the page being read and seek back to it instead.
  const changeViewMode = (mode: ViewMode) => {
    if (mode !== viewMode) {
      pendingScrollPageRef.current = currentPage
    }

    setViewMode(mode)
  }

  // The target only exists once the new layout has mounted, so the scroll waits
  // for the commit rather than running alongside the mode change.
  useEffect(() => {
    const pendingPage = pendingScrollPageRef.current

    if (pendingPage === null) {
      return
    }

    pendingScrollPageRef.current = null
    // The jump reads as a view swap rather than a scroll, so it lands instantly.
    scrollToPage(pendingPage, "auto")
  }, [viewMode])

  const submitPageNumber = () => {
    if (!pdfDocument) {
      setPageInput("0")
      return
    }

    const requestedPage = Number(pageInput)

    if (!Number.isInteger(requestedPage)) {
      setPageInput(String(currentPage))
      return
    }

    const pageNumber = Math.min(
      pdfDocument.numPages,
      Math.max(1, requestedPage),
    )
    setPageInput(String(pageNumber))
    scrollToPage(pageNumber)
  }

  const bookmarksLabel = bookmarksOpen
    ? t("toolbar.hideBookmarks")
    : t("toolbar.showBookmarks")

  const errorMessage =
    viewerError === "fileTooLarge"
      ? t("viewer.fileTooLarge")
      : viewerError === "invalidFile"
        ? t("viewer.invalidFile")
        : viewerError === "openFailed"
          ? t("viewer.openFailed")
          : viewerError === "exportFailed"
            ? t("annotate.exportFailed")
            : viewerError === "saveFailed"
              ? t("annotate.saveFailed")
              : viewerError === "annotateFailed"
                ? t("annotate.failed")
                : null

  return (
    <div className="h-svh overflow-hidden bg-background">
      {/* pb-px keeps the content box an even height: without it the bottom
          border leaves 47px, and centring a 32px control there puts its own
          border on a half pixel, which the WebView rounds per element — some
          outlines paint 1px solid, others two half-intensity rows. */}
      <header className="fixed inset-x-0 top-0 z-50 grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b bg-background/95 px-2 pb-px shadow-xs backdrop-blur">
        <div className="flex items-center gap-2 justify-self-start">
          <Toggle
            aria-label={bookmarksLabel}
            className="size-8"
            disabled={!pdfDocument}
            onPressedChange={setBookmarksOpen}
            pressed={bookmarksOpen}
            title={bookmarksLabel}
            variant="outline"
          >
            <Bookmark className={bookmarksOpen ? "fill-current" : undefined} />
          </Toggle>
          <ViewModeToggle
            disabled={!pdfDocument}
            onChange={changeViewMode}
            value={viewMode}
          />
          {/* Only worth showing once there is more than one file to align. */}
          {ranges.length >= 2 ? (
            <Toggle
              aria-label={t("files.smartPadding")}
              className="size-8"
              onPressedChange={toggleParity}
              pressed={parityEnabled}
              title={t("files.smartPaddingHint")}
              variant="outline"
            >
              <BookCopy />
            </Toggle>
          ) : null}
          {zoomApplies ? (
            <ZoomControls
              canZoomIn={zoom.canZoomIn}
              canZoomOut={zoom.canZoomOut}
              disabled={!pdfDocument}
              onReset={zoom.resetZoom}
              onToggleFit={zoom.toggleFit}
              onZoomIn={zoom.zoomIn}
              onZoomOut={zoom.zoomOut}
              zoomMode={zoom.zoomMode}
              zoomPercent={zoom.zoomPercent}
            />
          ) : null}
          <Button
            aria-label={t("toolbar.rotate")}
            disabled={!pdfDocument}
            onClick={() => setRotation((value) => (value + 90) % 360)}
            size="icon"
            title={t("toolbar.rotate")}
            variant="outline"
          >
            <RotateCw />
          </Button>
        </div>

        <div
          aria-label={t("toolbar.pageStatus", {
            current: currentPage,
            total: pdfDocument?.numPages ?? 0,
          })}
          className="flex min-w-24 items-center justify-center gap-2 font-mono text-sm tabular-nums"
          data-slot="page-status"
          role="group"
        >
          <input
            aria-label={t("toolbar.pageNumberInput")}
            className="h-7 w-10 rounded-md border bg-background px-1 text-center font-mono text-sm tabular-nums outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground"
            disabled={!pdfDocument}
            inputMode="numeric"
            onBlur={() => setPageInput(String(currentPage))}
            onChange={(event) =>
              setPageInput(event.target.value.replaceAll(/[^0-9]/g, ""))
            }
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submitPageNumber()
                event.currentTarget.blur()
              }
            }}
            type="text"
            value={pageInput}
          />
          <span className="text-muted-foreground">/</span>
          <span>{pdfDocument?.numPages ?? 0}</span>
          <span aria-live="polite" className="sr-only">
            {t("toolbar.pageStatus", {
              current: currentPage,
              total: pdfDocument?.numPages ?? 0,
            })}
          </span>
        </div>

        <div className="flex items-center gap-2 justify-self-end">
          <AnnotationToolbar
            activeTool={activeTool}
            canRedo={annotations.canRedo}
            canUndo={annotations.canUndo}
            disabled={!pdfDocument}
            hasMergedFiles={hasMergedContent}
            hasPageNumbers={annotations.pageNumbersConfig !== null}
            hasSourceFile={Boolean(pdfDocument?.path)}
            hasWatermark={annotations.watermarkConfig !== null}
            highlightApplies={drawingApplies}
            highlightColor={highlightColor}
            isDirty={annotations.isDirty}
            onExport={() => void exportPdf()}
            onHighlightColorChange={changeHighlightColor}
            onPageNumbers={pageNumbers.openDialog}
            onRectStyleChange={changeRectStyle}
            onRedo={() => {
              // Only a page-moving step would strand the note on a page that has
              // shifted or gone, and undo/redo cannot take the uncommitted note
              // as their target; so the draft is discarded before such a step,
              // but an annotation step (a highlight, say) leaves it to finish.
              // The target is the head of the queue's live history.
              const target = annotations.historyNow().future.at(-1)?.command
              if (target && movesPages(target)) {
                cancelTextNote()
              }
              void annotations.redo()
            }}
            onSave={() => void annotations.save()}
            onToolChange={setActiveTool}
            onUndo={() => {
              const target = annotations.historyNow().past.at(-1)?.command
              if (target && movesPages(target)) {
                cancelTextNote()
              }
              void annotations.undo()
            }}
            onWatermark={watermark.openDialog}
            rectApplies={drawingApplies}
            rectStyle={rectStyle}
            textNoteApplies={drawingApplies}
          />
          <SettingsDialog />
        </div>
      </header>

      <div className="flex h-full pt-12">
        {pdfDocument && bookmarksOpen ? (
          <BookmarkSidebar
            items={pdfDocument.outline}
            onNavigate={scrollToPage}
          />
        ) : null}

        <main
          className={cn(
            "relative min-w-0 flex-1 overflow-auto bg-zinc-200/70 dark:bg-zinc-950",
            // Only while the tool can actually draw: the thumbnail grid hides
            // the toggle that would turn it back off, so a crosshair left over
            // it would promise a drag that does nothing.
            drawingRect && "cursor-crosshair",
            drawingTextNote && "cursor-text",
          )}
          ref={viewerRef}
        >
          {pdfDocument ? (
            <PdfViewerLayout
              currentPage={currentPage}
              documentId={pdfDocument.id}
              draft={rectDraft ?? undefined}
              fileName={fileName}
              filesEdit={{
                onAddFile: () => void chooseFileToMerge(),
                onDeleteFile: (range) => void deleteFile(range),
                onReorderPages: (order) => void reorderFiles(order),
                ranges,
              }}
              key={pdfDocument.id}
              pageEdit={{
                onDeletePage: deleteThumbnailPage,
                onInsertBlankPage: insertBlankPage,
                onOpenPage: openThumbnailPage,
                onReorderPages: reorderPages,
                onSelectPage: selectThumbnailPage,
                selectedPages: thumbnailSelection.selectedPages,
              }}
              pages={pdfDocument.pages}
              referencePageWidth={zoom.referencePageWidth}
              renderEpochs={annotations.renderEpochs}
              rotation={rotation}
              scale={zoom.scale}
              textEpochs={annotations.textEpochs}
              textSelectionDragging={textSelectionDragging}
              viewMode={viewMode}
              viewerWidth={viewerWidth}
              zoomPreviewing={zoom.zoomPreviewing}
            />
          ) : (
            <div className="grid min-h-full place-items-center p-8">
              <div className="flex w-full max-w-xl flex-col items-center">
                {/* A button to the native picker, where the file input used to
                    be: the WebView's own picker hands over `File` objects that
                    never carry a filesystem path, and saving needs the path. */}
                <button
                  aria-label={t("viewer.chooseFile")}
                  className="group flex w-full cursor-pointer flex-col items-center rounded-2xl border border-dashed border-zinc-400 bg-background/75 px-8 py-14 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
                  data-slot="drop-zone"
                  disabled={isLoading}
                  onClick={() => void chooseFile()}
                  type="button"
                >
                  {isLoading ? (
                    <LoaderCircle className="mb-5 size-10 animate-spin text-muted-foreground" />
                  ) : (
                    <FileUp className="mb-5 size-10 text-muted-foreground transition-transform group-hover:-translate-y-0.5" />
                  )}
                  <span className="text-lg font-semibold">
                    {isLoading ? t("viewer.loading") : t("viewer.dropTitle")}
                  </span>
                  <span className="mt-2 text-sm text-muted-foreground">
                    {fileName || t("viewer.dropDescription")}
                  </span>
                </button>
                {/* Outside the button: ARIA flattens a button's children to its
                    name, so an alert inside would announce as nothing. */}
                {errorMessage ? (
                  <span className="mt-4 text-sm text-destructive" role="alert">
                    {errorMessage}
                  </span>
                ) : null}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Outside the viewer's own scroll box, in the screen space it positions
          itself against — inside, it would scroll away from the page it belongs
          to and turn with the page it sits on. */}
      {textNote.draft && pdfDocument?.pages[textNote.draft.pageNumber - 1] ? (
        <TextNoteEditor
          draft={textNote.draft}
          editorRef={textNote.editorRef}
          onCancel={textNote.cancel}
          onCommit={textNote.commit}
          onStyleChange={changeTextNoteStyle}
          onTextChange={textNote.setText}
          page={pdfDocument.pages[textNote.draft.pageNumber - 1]!}
          rotation={rotation}
          style={textNoteStyle}
          viewerRef={viewerRef}
        />
      ) : null}

      <WatermarkDialog
        draft={watermark.draft}
        hasWatermark={watermark.hasWatermark}
        isApplying={watermark.isApplying}
        onApply={() => void watermark.apply()}
        onDraftChange={watermark.setDraft}
        onOpenChange={watermark.onOpenChange}
        onRemove={() => void watermark.remove()}
        open={watermark.open}
        validationError={watermark.validationError}
      />

      <PageNumbersDialog
        draft={pageNumbers.draft}
        hasPageNumbers={pageNumbers.hasPageNumbers}
        isApplying={pageNumbers.isApplying}
        onApply={() => void pageNumbers.apply()}
        onDraftChange={pageNumbers.setDraft}
        onOpenChange={pageNumbers.onOpenChange}
        onRemove={() => void pageNumbers.remove()}
        open={pageNumbers.open}
        pageCount={pdfDocument?.numPages ?? 0}
        validationError={pageNumbers.validationError}
      />

      {isDragging ? (
        <div className="pointer-events-none fixed inset-3 top-15 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <FileUp className="mb-4 size-12" />
            <p className="text-lg font-semibold">
              {pdfDocument ? t("viewer.dropNowMerge") : t("viewer.dropNow")}
            </p>
            {pdfDocument ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t("viewer.appendHint")}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {pdfDocument && errorMessage ? (
        <div
          className="fixed right-4 top-16 z-40 rounded-lg border border-destructive/20 bg-background px-4 py-2 text-sm text-destructive shadow-lg"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

      <AlertDialog
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) {
            setPendingAction(null)
          }
        }}
        open={pendingAction !== null}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("viewer.unsavedTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "close"
                ? t("viewer.unsavedCloseDescription")
                : t("viewer.unsavedDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("viewer.unsavedCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingAction
                setPendingAction(null)

                if (action?.kind === "open") {
                  void loadPdfFromPath(action.path)
                } else if (action?.kind === "close") {
                  // `destroy` rather than `close`: close would raise another
                  // close-requested and land back in this dialog.
                  void getCurrentWindow().destroy()
                }
              }}
            >
              {pendingAction?.kind === "close"
                ? t("viewer.unsavedCloseConfirm")
                : t("viewer.unsavedConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
