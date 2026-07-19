import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import {
  Bookmark,
  FileUp,
  LoaderCircle,
  RotateCw,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { BookmarkSidebar } from "@/components/BookmarkSidebar"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { TextNoteEditor } from "@/components/TextNoteEditor"
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
import {
  isPdfFile,
  MAX_PDF_BYTES,
  type PdfDocumentInfo,
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
  | null

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
  const viewerRef = useRef<HTMLElement>(null)
  const documentRef = useRef<PdfDocumentInfo | null>(null)
  const requestIdRef = useRef(0)
  const dragDepthRef = useRef(0)
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
    // A toast that outlives what it describes would sit over every mark the
    // reader went on to make successfully.
    onSuccess: useCallback(() => setViewerError(null), []),
  })
  const resetAnnotations = annotations.reset

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

  const exportPdf = useCallback(async () => {
    if (!pdfDocument) {
      return
    }

    try {
      const path = await save({
        defaultPath: t("annotate.exportDefaultName"),
        filters: [{ extensions: ["pdf"], name: t("annotate.exportFilter") }],
      })

      if (path) {
        await annotations.exportTo(path)
      }
    } catch {
      // Only the picker itself; `exportTo` reports a failed write on its own.
      setViewerError("exportFailed")
    }
  }, [annotations, pdfDocument, t])

  const loadPdf = useCallback(async (file: File) => {
    if (!isPdfFile(file)) {
      setViewerError("invalidFile")
      return
    }

    if (file.size > MAX_PDF_BYTES) {
      setViewerError("fileTooLarge")
      return
    }

    const requestId = ++requestIdRef.current
    setViewerError(null)
    setIsLoading(true)
    setFileName(file.name)
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
      const data = new Uint8Array(await file.arrayBuffer())

      if (requestId !== requestIdRef.current) {
        return
      }

      const nextDocument = await invoke<PdfDocumentInfo>("open_pdf", data)

      if (requestId !== requestIdRef.current) {
        closePdf(nextDocument.id)
        return
      }

      documentRef.current = nextDocument
      setPdfDocument(nextDocument)
      setCurrentPage(1)
    } catch {
      if (requestId === requestIdRef.current) {
        setFileName("")
        setViewerError("openFailed")
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [resetAnnotations, resetZoomToDefault])

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

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1
    setIsDragging(true)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
    }
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setIsDragging(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)

    const droppedFile = Array.from(event.dataTransfer.files).find(isPdfFile)

    if (!droppedFile) {
      setViewerError("invalidFile")
      return
    }

    void loadPdf(droppedFile)
  }

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]
    event.target.value = ""

    if (selectedFile) {
      void loadPdf(selectedFile)
    }
  }

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
            : viewerError === "annotateFailed"
              ? t("annotate.failed")
              : null

  return (
    <div
      className="h-svh overflow-hidden bg-background"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className="fixed inset-x-0 top-0 z-50 grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b bg-background/95 px-2 shadow-xs backdrop-blur">
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
          <AnnotationToolbar
            activeTool={activeTool}
            canRedo={annotations.canRedo}
            canUndo={annotations.canUndo}
            disabled={!pdfDocument}
            highlightApplies={drawingApplies}
            highlightColor={highlightColor}
            onExport={() => void exportPdf()}
            onHighlightColorChange={changeHighlightColor}
            onRectStyleChange={changeRectStyle}
            onRedo={() => void annotations.redo()}
            onToolChange={setActiveTool}
            onUndo={() => void annotations.undo()}
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
              viewMode={viewMode}
              viewerWidth={viewerWidth}
            />
          ) : (
            <div className="grid min-h-full place-items-center p-8">
              <label className="group flex w-full max-w-xl cursor-pointer flex-col items-center rounded-2xl border border-dashed border-zinc-400 bg-background/75 px-8 py-14 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-within:ring-3 focus-within:ring-ring/50 dark:border-zinc-700">
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
                <input
                  accept="application/pdf,.pdf"
                  aria-label={t("viewer.chooseFile")}
                  className="sr-only"
                  disabled={isLoading}
                  onChange={handleFileInput}
                  type="file"
                />
                {errorMessage ? (
                  <span className="mt-4 text-sm text-destructive" role="alert">
                    {errorMessage}
                  </span>
                ) : null}
              </label>
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
    </div>
  )
}
