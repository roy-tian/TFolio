import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
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
import { useHighlightTool } from "@/hooks/useHighlightTool"
import { useRectTool } from "@/hooks/useRectTool"
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
import type { HexColor, RectStyle, TextNoteStyle } from "@/lib/annotations"
import { e2eOverride, isE2eBuild } from "@/lib/e2e"
import {
  fileNameFromPath,
  isPdfPath,
  type PdfDocumentInfo,
  type PdfExportOutcome,
} from "@/lib/pdf"
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
  const requestIdRef = useRef(0)
  const pendingScrollPageRef = useRef<number | null>(null)

  // The thumbnail grid gives every cell the same width whatever the page, so it
  // has no single scale to report and nothing for a zoom to act on. The controls
  // are absent there rather than disabled: disabled reads as "not just now",
  // which is what an unopened document means, and it would leave the readout
  // showing a figure that describes nothing on screen.
  const zoomApplies = viewMode !== "thumbnail"
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

  // Every drawing tool needs a page under the pointer, and the thumbnail grid
  // has none. Only the tools: undo, redo, and export act on the document rather
  // than on a page, so they stay.
  const drawingApplies = viewMode !== "thumbnail"
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

  useHighlightTool({
    active: Boolean(pdfDocument) && drawingApplies && activeTool === "highlight",
    color: highlightColor,
    onCommit: annotations.commit,
    opacity: HIGHLIGHT_OPACITY,
    pages: pdfDocument?.pages ?? [],
    rotation,
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

  const loadPdfFromPath = useCallback(async (path: string) => {
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
    setActiveTool(null)
    setBookmarksOpen(false)
    setPdfDocument(null)

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
      setCurrentPage(1)
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
  }, [resetAnnotations, resetZoomToDefault])

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

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
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

    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      const width = rect?.width ?? viewer.clientWidth
      const height = rect?.height ?? viewer.clientHeight
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => commitSize(width, height), 180)
    })
    resizeObserver.observe(viewer)

    return () => {
      clearTimeout(resizeTimer)
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    storeViewMode(viewMode)
  }, [viewMode])

  useCurrentPageTracker(viewerRef, pdfDocument?.id, viewMode, setCurrentPage)

  // The listener outlives every render, so it reads the latest opener through a
  // ref rather than resubscribing to the webview each time the history moves.
  const requestOpenPathRef = useRef(requestOpenPath)

  useEffect(() => {
    requestOpenPathRef.current = requestOpenPath
  }, [requestOpenPath])

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
          const path = event.payload.paths.find(isPdfPath)

          if (!path) {
            setViewerError("invalidFile")
            return
          }

          requestOpenPathRef.current(path)
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

  // Picking a thumbnail leaves the grid for the page itself.
  const selectThumbnail = (pageNumber: number) => {
    pendingScrollPageRef.current = pageNumber
    setViewMode("single")
  }

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
            hasSourceFile={Boolean(pdfDocument?.path)}
            hasWatermark={annotations.watermarkConfig !== null}
            highlightApplies={drawingApplies}
            highlightColor={highlightColor}
            isDirty={annotations.isDirty}
            onExport={() => void exportPdf()}
            onHighlightColorChange={changeHighlightColor}
            onRectStyleChange={changeRectStyle}
            onRedo={() => void annotations.redo()}
            onSave={() => void annotations.save()}
            onToolChange={setActiveTool}
            onUndo={() => void annotations.undo()}
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
              onSelectThumbnail={selectThumbnail}
              pages={pdfDocument.pages}
              referencePageWidth={zoom.referencePageWidth}
              renderEpochs={annotations.renderEpochs}
              rotation={rotation}
              scale={zoom.scale}
              textEpochs={annotations.textEpochs}
              viewMode={viewMode}
              viewerWidth={viewerWidth}
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

      {isDragging ? (
        <div className="pointer-events-none fixed inset-3 top-15 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <FileUp className="mb-4 size-12" />
            <p className="text-lg font-semibold">{t("viewer.dropNow")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("viewer.replaceHint")}
            </p>
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
