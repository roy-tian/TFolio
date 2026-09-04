import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { invoke } from "@tauri-apps/api/core"
import { Bookmark, RotateCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import { BookmarkSidebar } from "@/components/BookmarkSidebar"
import { HistoryControls } from "@/components/HistoryControls"
import { PageNumbersDialog } from "@/components/PageNumbersDialog"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { TextNoteEditor } from "@/components/TextNoteEditor"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { WatermarkDialog } from "@/components/WatermarkDialog"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { WindowControls } from "@/components/WindowControls"
import { ZoomControls } from "@/components/ZoomControls"
import { ZoomIndicator } from "@/components/ZoomIndicator"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { useAnnotations } from "@/hooks/useAnnotations"
import { useCurrentPageTracker } from "@/hooks/useCurrentPageTracker"
import { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import { useEraserTool } from "@/hooks/useEraserTool"
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
  isNoteFontMissing,
  readStoredHighlightColor,
  readStoredRectStyle,
  readStoredTextNoteStyle,
  storeHighlightColor,
  storeRectStyle,
  storeTextNoteStyle,
} from "@/lib/annotationStyles"
import {
  movesPages,
  type AnnotationCommand,
  type HexColor,
  type RectStyle,
  type TextNoteStyle,
} from "@/lib/annotations"
import { panelElementId, tabElementId } from "@/lib/documentTabs"
import { dropHitAt, insertIndexForHit } from "@/lib/fileDrop"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import {
  isPdfPath,
  type PdfDocumentInfo,
  type PdfExportOutcome,
  type PdfStructureUpdate,
} from "@/lib/pdf"
import { isMacOS } from "@/lib/platform"
import type { PdfOwnedLayerProgressHandler } from "@/lib/progress"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import {
  defaultViewMode,
  effectiveViewMode,
  hasBookSpread,
  readStoredViewMode,
  storeViewMode,
  type ViewMode,
} from "@/lib/viewMode"
import { isNoteWorthKeeping } from "@/lib/textNoteDraft"
import { cn } from "@/lib/utils"
import {
  anchorCorrection,
  anchorOnPage,
  type ViewportAnchor,
} from "@/lib/viewportAnchor"
import type { WatermarkConfig } from "@/lib/watermark"
import { CONTENT_PADDING_X, CONTENT_PADDING_Y } from "@/lib/zoom"

type ViewerError =
  | "annotateFailed"
  | "editInFlight"
  | "exportFailed"
  | "fileTooLarge"
  | "invalidFile"
  | "noteFontFailed"
  | "noteFontMissing"
  | "openFailed"
  | "saveFailed"
  | null

/** A file dragged in from the desktop, as the window's own handler sees it —
    positions in CSS pixels, not the OS's physical ones. `over` carries the
    paths the drag announced on entry, or null when the window never heard
    them; the OS itself names them only on entry and on release. */
export type FileDragEvent =
  | { kind: "over"; paths: string[] | null; point: { x: number; y: number } }
  | { kind: "drop"; paths: string[]; point: { x: number; y: number } }
  | { kind: "leave" }

export type DocumentSessionHandle = {
  hasUnsavedWorkNow: () => boolean
  /** Whether this session takes the drag: true only over its thumbnail grid,
      where a dropped PDF is inserted at the gap under the pointer instead of
      opening as a tab of its own. */
  onFileDrag: (event: FileDragEvent) => boolean
}

type DocumentSessionProps = {
  active: boolean
  document: PdfDocumentInfo
  fileName: string
  /** Page numbers to lay on as the session opens — what the merge wizard asked
      for. Applied through the ordinary command, so they are one undo away and
      the dialog finds them where it expects. */
  initialPageNumbers?: PageNumbersConfig | null
  /** The view this document opens in, where something other than the reader's
      stored preference suits it: a merge opens on the thumbnail grid, which is
      where the whole result can be looked over at once. */
  initialViewMode?: ViewMode
  /** Reports the merge wizard's initial page-content work while it stays open. */
  onInitialLayerProgress?: PdfOwnedLayerProgressHandler
  /** Resolves the merge wizard once all requested initial layers have settled. */
  onInitialLayersSettled?: () => void
  /** A watermark to lay on as the session opens — see `initialPageNumbers`. */
  initialWatermark?: WatermarkConfig | null
  /** The workspace half of the header's menu, which every tab shares. */
  menu: AppMenuActions
  onDirtyChange: (documentId: number, dirty: boolean) => void
  /** An export that gave a document its first file: the tab now stands for
      that file, not for the bytes it opened from. */
  onSourceChange: (documentId: number, path: string) => void
}

function closePdf(documentId: number) {
  void invoke("close_pdf", { documentId }).catch(() => undefined)
}

export const DocumentSession = forwardRef<DocumentSessionHandle, DocumentSessionProps>(
function DocumentSession(
  {
    active,
    document: openedDocument,
    fileName,
    initialPageNumbers,
    initialViewMode,
    initialWatermark,
    menu,
    onInitialLayerProgress,
    onInitialLayersSettled,
    onDirtyChange,
    onSourceChange,
  },
  ref,
) {
  const { t } = useTranslation()
  const macOS = isMacOS()
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentInfo>(openedDocument)
  // Whether any page another file brought in is still here, which — like a
  // watermark — leaves the document export-only. The backend answers it with
  // every structure update, so this never has to be replayed from history: a
  // freshly opened document holds none of them.
  const [hasMergedPages, setHasMergedPages] = useState(false)
  // Where a PDF dragged in from the desktop would land, while one is over the
  // grid. Only the insertion line reads it; the drop itself resolves the point
  // again, so a stale index can never place a file.
  const [fileDropIndex, setFileDropIndex] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageInput, setPageInput] = useState("1")
  const [rotation, setRotation] = useState(0)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [viewerError, setViewerError] = useState<ViewerError>(null)
  /**
   * The edit that failed for want of a face to draw it in, kept so accepting
   * the download can re-run it. A note's text lives nowhere else by then — the
   * editor that held it closed when the note was committed — so without this
   * the reader would fetch a 17 MB font and then have to type the note again.
   */
  const [unfontedEdit, setUnfontedEdit] = useState<AnnotationCommand | null>(
    null,
  )
  const [fetchingNoteFont, setFetchingNoteFont] = useState(false)
  const [viewerWidth, setViewerWidth] = useState(0)
  const [viewerHeight, setViewerHeight] = useState(0)
  const [preferredViewMode, setPreferredViewMode] = useState<ViewMode>(
    () => initialViewMode ?? readStoredViewMode() ?? defaultViewMode,
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
  const documentRef = useRef<PdfDocumentInfo | null>(openedDocument)
  const pendingScrollPageRef = useRef<number | null>(null)
  // Where the reader was when the viewport last changed size, taken before the
  // layout that change resolves to, and paid back once it has been made.
  const resizeAnchorRef = useRef<ViewportAnchor | null>(null)
  // The tracked page, for the resize observer below: it is bound once, so it
  // cannot read a value that re-renders.
  const currentPageRef = useRef(currentPage)
  // The last geometry the viewer really had, which a hidden tab keeps.
  const committedSizeRef = useRef({ height: 0, width: 0 })
  const mountedRef = useRef(false)

  const bookApplies = hasBookSpread(pdfDocument.numPages)
  const viewMode = effectiveViewMode(preferredViewMode, pdfDocument.numPages)
  // The mode the last commit actually laid out, so a switch can be told from a
  // re-render. Seeded with the mode the first render shows, which is why it sits
  // here rather than with the refs above — and it tracks the laid-out mode, not
  // the reader's stored choice, since it is the layout that strands an offset.
  const laidOutViewModeRef = useRef(viewMode)

  // The thumbnail grid gives every cell the same width whatever the page, so it
  // has no single scale to report or anything for a zoom to act on. The controls
  // are absent there rather than disabled: disabled reads as "not just now",
  // which is what an unopened document means, and it would leave the readout
  // showing a figure that describes nothing on screen.
  const zoomApplies = viewMode === "single" || viewMode === "book"
  const bookmarksApply = viewMode === "thumbnail"
  const zoom = useZoom({
    contentHeight: Math.max(0, viewerHeight - CONTENT_PADDING_Y),
    contentWidth: Math.max(0, viewerWidth - CONTENT_PADDING_X),
    currentPage,
    disabled: !active || !zoomApplies,
    pages: pdfDocument?.pages ?? [],
    rotation,
    viewMode,
    viewerRef,
  })
  // Every drawing tool needs a page under the pointer, which the thumbnail grid
  // does not show. Only the watermark and the page numbers act on the document
  // rather than a page, so they stay.
  const drawingApplies = viewMode === "single" || viewMode === "book"
  // In the thumbnail grid a click is a selection, so the grid doubles as the
  // page-editing surface; leaving it clears what was chosen.
  const thumbnailSelection = useThumbnailSelection({
    active: active && viewMode === "thumbnail",
  })
  const clearThumbnailSelection = thumbnailSelection.clear
  const annotations = useAnnotations({
    documentId: pdfDocument?.id,
    onAnnotateError: useCallback(
      (error?: unknown, command?: AnnotationCommand) => {
        // The one refusal with a way out: nothing installed can draw this text,
        // and the reader can fetch something that will.
        if (isNoteFontMissing(error)) {
          setUnfontedEdit(command ?? null)
          setViewerError("noteFontMissing")
          return
        }

        setViewerError("annotateFailed")
      },
      [],
    ),
    onExportError: useCallback(() => setViewerError("exportFailed"), []),
    // A byte-opened document adopts its first export's destination as its
    // source, which is when `path` appears and the save key comes alive.
    onExported: useCallback(
      (documentId: number, outcome: PdfExportOutcome) => {
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
        onSourceChange(documentId, outcome.path)
      },
      [onSourceChange],
    ),
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
        setHasMergedPages(update.hasMergedPages)
        setCurrentPage((page) =>
          Math.min(Math.max(page, 1), Math.max(1, update.numPages)),
        )
        clearThumbnailSelection()
      },
      [clearThumbnailSelection],
    ),
    // A toast that outlives what it describes would sit over every mark the
    // reader went on to make successfully. The edit held for a retry goes with
    // it: once the offer is off the screen there is no way back to it, so
    // keeping the edit would only leave it to be re-run by the next offer.
    onSuccess: useCallback(() => {
      setViewerError(null)
      setUnfontedEdit(null)
    }, []),
  })
  const watermark = useWatermark({
    activeConfig: annotations.watermarkConfig,
    defaultText: t("watermark.defaultText"),
    documentId: pdfDocument?.id,
    onCancel: annotations.cancelOperation,
    onSet: annotations.setWatermark,
    pageCount: pdfDocument?.numPages ?? 0,
  })
  const pageNumbers = usePageNumbers({
    activeConfig: annotations.pageNumbersConfig,
    documentId: pdfDocument?.id,
    onCancel: annotations.cancelOperation,
    onSet: annotations.setPageNumbers,
    pageCount: pdfDocument?.numPages ?? 0,
  })

  const textSelectionDragging = useHighlightTool({
    active: active && drawingApplies && activeTool === "highlight",
    color: highlightColor,
    onCommit: annotations.commit,
    opacity: HIGHLIGHT_OPACITY,
    pages: pdfDocument?.pages ?? [],
    rotation,
    selectable:
      active &&
      drawingApplies &&
      (activeTool === null || activeTool === "highlight"),
    viewerRef,
  })

  const drawingRect = drawingApplies && activeTool === "rect"
  const rectDraft = useRectTool({
    active: active && drawingRect,
    onCommit: annotations.commit,
    pages: pdfDocument?.pages ?? [],
    rotation,
    style: rectStyle,
    viewerRef,
  })

  const erasing = drawingApplies && activeTool === "eraser"
  useEraserTool({
    active: active && erasing,
    onErase: annotations.eraseAt,
    pages: pdfDocument?.pages ?? [],
    rotation,
    viewerRef,
  })

  const drawingTextNote = drawingApplies && activeTool === "textNote"
  const textNote = useTextNoteTool({
    active: drawingTextNote,
    onCommit: annotations.commit,
    suspended: !active,
    pages: pdfDocument.pages,
    rotation,
    style: textNoteStyle,
    viewerRef,
  })
  const draftDirty = isNoteWorthKeeping(textNote.draft?.text ?? "")
  const hasUnsavedWorkNow = useCallback(
    () =>
      annotations.isDirtyNow() ||
      annotations.hasPendingWorkNow() ||
      isNoteWorthKeeping(textNote.draft?.text ?? ""),
    [annotations, textNote.draft?.text],
  )

  useEffect(() => {
    onDirtyChange(openedDocument.id, annotations.isDirty || draftDirty)
  }, [annotations.isDirty, draftDirty, onDirtyChange, openedDocument.id])

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

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false

      queueMicrotask(() => {
        if (!mountedRef.current && documentRef.current) {
          closePdf(documentRef.current.id)
          documentRef.current = null
        }
      })
    }
  }, [])

  // Applied once, on the first render of a session that was handed them: the
  // wizard's own steps, run through the same commands the dialogs use so the
  // reader can undo either. Page numbers first, so the watermark lands above
  // them — the order the two dialogs leave a document in.
  const initialLayers = useRef({
    pageNumbers: initialPageNumbers ?? null,
    watermark: initialWatermark ?? null,
  })

  useEffect(() => {
    const { pageNumbers, watermark } = initialLayers.current

    if (!pageNumbers && !watermark) {
      return
    }

    initialLayers.current = { pageNumbers: null, watermark: null }

    void (async () => {
      const pageCount = documentRef.current?.numPages ?? 0

      try {
        if (pageNumbers) {
          const outcome = await annotations.setPageNumbers(
            pageNumbers,
            pageCount,
            (progress) => onInitialLayerProgress?.("pageNumbers", progress),
          )

          // One stop ends the whole opening sequence: the reader asked to be
          // out of it, not to sit through the layer after it.
          if (outcome === "cancelled") {
            return
          }
        }
        if (watermark) {
          await annotations.setWatermark(
            watermark,
            pageCount,
            (progress) => onInitialLayerProgress?.("watermark", progress),
          )
        }
      } finally {
        // The wizard owns the progress surface; it closes whether a layer
        // landed or reported its failure through the session's normal error.
        onInitialLayersSettled?.()
      }
    })()
    // The layers and their lifecycle callbacks belong to this one-shot ref
    // effect. Strict Mode's second effect sees the ref already cleared.
  }, [])

  useEffect(() => {
    currentPageRef.current = currentPage
    setPageInput(String(currentPage))
  }, [currentPage])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    // The reader's place, as a point on the page they are on, taken while the
    // document is still laid out for the size the viewer has just left. Every
    // mode that fits pages to the column takes its scale from that width, so a
    // window dragged sideways re-lays the whole document out under a scroll
    // offset the browser keeps in pixels — and the reader, who asked for a
    // change of width, watches the page slide vertically away from them.
    //
    // The reading line is the viewer's top edge: everything above it has been
    // read, and holding it still is what "the document did not move" means. The
    // point is taken at the middle of the width, which is where the column
    // centres what it lays out.
    const captureResizeAnchor = () => {
      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${currentPageRef.current}"]`,
      )
      const rect = viewer.getBoundingClientRect()
      const pageRect = page?.getBoundingClientRect()

      // Only a page on screen can hold the reader's place. The tracked page is
      // named the moment a seek starts, so a smooth `scrollToPage` still on its
      // way names a page pages off; anchoring to that would scale the gaps and
      // padding between here and there, which no re-fit scales, and would land
      // the correction — cancelling the seek's animation as it writes — nowhere
      // the reader ever was.
      resizeAnchorRef.current =
        pageRect && pageRect.bottom > rect.top && pageRect.top < rect.bottom
          ? anchorOnPage(
              currentPageRef.current,
              pageRect,
              rect.left + rect.width / 2,
              rect.top,
            )
          : null
    }

    // An inactive tab is `hidden`, so it has no layout box and the observer
    // reports 0x0. Committing that would lay every page out at the minimum
    // scale, and the collapsed scroll height is what the viewer's offset is
    // clamped against — the reader's place in the document, lost before the tab
    // is even shown again. Hold the last real geometry instead; the observer
    // reports the true size again the moment the panel comes back.
    const commitSize = (width: number, height: number) => {
      const roundedWidth = Math.round(width)
      const roundedHeight = Math.round(height)

      if (roundedWidth <= 0 || roundedHeight <= 0) {
        return
      }

      const committed = committedSizeRef.current

      if (
        roundedWidth === committed.width &&
        roundedHeight === committed.height
      ) {
        return
      }

      // Not on the first size, which has no reading position behind it, and not
      // when a seek is already pending — a tab coming back to a window resized
      // without it holds a position from a layout that no longer exists, and
      // has its own way of finding the page again.
      if (committed.width > 0 && pendingScrollPageRef.current === null) {
        captureResizeAnchor()
      }

      if (roundedWidth !== committed.width) {
        committed.width = roundedWidth
        setViewerWidth(roundedWidth)
      }

      if (roundedHeight !== committed.height) {
        committed.height = roundedHeight
        setViewerHeight(roundedHeight)
      }
    }

    commitSize(viewer.clientWidth, viewer.clientHeight)

    // Commit every observed size straight away. Layout — the grid's column
    // count, a fit mode's page scale — tracks the window in real time, while
    // the heavy PDFium renders stay throttled by the viewer's settled
    // `renderScale` debounce. ResizeObserver already batches to one callback
    // per frame, so a timer here would only add the lag of waiting for it.
    // Measured off the element rather than the entry's `contentRect`, so every
    // committed figure comes from the same box the activation check below reads.
    const resizeObserver = new ResizeObserver(() => {
      commitSize(viewer.clientWidth, viewer.clientHeight)
    })
    resizeObserver.observe(viewer)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  // Pay the anchor back against the pages as they have just been laid out. A
  // layout effect, so the correction lands in the same frame as the new sizes
  // and the reader sees the column change width, not the document jump.
  useLayoutEffect(() => {
    const anchor = resizeAnchorRef.current
    const viewer = viewerRef.current

    // A seek queued after the anchor was taken owns the offset instead: it names
    // a page to find in the layout that has just been made, while the anchor
    // describes one that was never committed.
    if (!anchor || !viewer || pendingScrollPageRef.current !== null) {
      resizeAnchorRef.current = null
      return
    }

    resizeAnchorRef.current = null

    const page = viewer.querySelector<HTMLElement>(
      `[data-page-number="${anchor.pageNumber}"]`,
    )

    if (!page) {
      return
    }

    const correction = anchorCorrection(anchor, page.getBoundingClientRect())
    viewer.scrollLeft += correction.left
    viewer.scrollTop += correction.top
  }, [viewerHeight, viewerWidth])

  // The geometry a hidden tab holds can be out of date, since the window may
  // have been resized while another tab had the screen: the new size reaches
  // this one only as it comes back, and the offset it kept would then point into
  // a document laid out at a different scale. Seek to the page being read
  // instead, once the size it was measured against has been committed.
  //
  // It has to be a layout effect: the observer delivers the panel's new size
  // before a passive effect would run, and its commit writes the very ref this
  // compares against — leaving nothing to notice, and the reader stranded.
  useLayoutEffect(() => {
    const viewer = viewerRef.current

    if (!active || !viewer) {
      return
    }

    const committed = committedSizeRef.current

    if (
      viewer.clientWidth === committed.width &&
      viewer.clientHeight === committed.height
    ) {
      return
    }

    pendingScrollPageRef.current = currentPage
  }, [active, currentPage])

  // A view this document was opened in rather than chosen in is not the
  // reader's preference, so it is not stored — only what they press after is.
  const viewModeChosen = useRef(initialViewMode === undefined)

  useEffect(() => {
    if (!viewModeChosen.current) {
      viewModeChosen.current = true
      return
    }

    storeViewMode(preferredViewMode)
  }, [preferredViewMode])

  // A structure edit reachable while a note is open must settle the draft
  // *before* it runs — a note is anchored by page number, which an edit can move
  // out from under it, and a note the reader finishes mid-edit would be dropped
  // by the in-flight-edit guard after the editor had already cleared its text.
  // Undo and redo can move any page and can't take a note as their target, so
  // the uncommitted draft is discarded before the step (see the toolbar); every
  // other page edit lives in the thumbnail grid, where no note can be open. The
  // callback is stable.
  const cancelTextNote = textNote.cancel

  useCurrentPageTracker(
    viewerRef,
    active ? pdfDocument.id : undefined,
    viewMode,
    setCurrentPage,
    zoom.zoomPreviewing,
  )

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
    setBookmarksOpen(false)
    setPreferredViewMode("single")
  }

  const selectThumbnailPage = (
    pageNumber: number,
    modifiers: SelectionModifiers,
  ) => {
    thumbnailSelection.select(pageNumber, modifiers)
  }

  // Every page-editing gesture carries page numbers read off the screen, so it
  // must not be queued behind a *page-shifting* edit, or it would land on the
  // wrong page. The gesture is dropped while such an edit is in flight; the
  // pages the reader sees then always match the numbers their next gesture
  // names. An annotation in flight, which shifts nothing, does not block
  // editing. Checked off the ref so a gesture in the same tick as the edit that
  // started the churn is caught.
  const editingBusy = () => annotations.isStructureBusyNow()

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

    void annotations.deletePages(pages, pdfDocument.numPages)
  }

  const insertBlankPage = (index: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.insertBlankPage(index, pdfDocument.numPages)
  }

  // Answered with, rather than voided: the grid holds the pages where the drop
  // put them until this settles, since nothing moves before the backend has.
  const reorderPages = (order: number[]) => {
    if (editingBusy()) {
      return
    }

    return annotations.reorderPages(order)
  }

  // Page content this session owns (a watermark, page numbers) and merged
  // pages each leave the document export-only, for the reasons the menu's hint
  // gives; a document opened from bytes has no file to write back to at all.
  const hasOwnedContent =
    annotations.watermarkConfig !== null || annotations.pageNumbersConfig !== null
  const hasSourceFile = Boolean(pdfDocument?.path)
  const canSave =
    hasSourceFile && annotations.isDirty && !hasOwnedContent && !hasMergedPages
  // Only where the reason is not already in front of the reader. Owned page
  // content is named first — it is the stricter, less recoverable reason.
  const saveHint = hasOwnedContent
    ? t("annotate.saveOwnedContent")
    : hasMergedPages
      ? t("annotate.saveMerged")
      : hasSourceFile
        ? undefined
        : t("annotate.saveNoSource")
  // Inserts each PDF in turn at `index`, in the order they were dropped: the
  // second file goes after the first, so a multi-file drop reads down the grid
  // the way the reader arranged it. How far to advance is what the file itself
  // brought — only the backend knows that, and only it can say, since the
  // document's own growth would also count an edit that landed in between.
  const insertFiles = useCallback(
    async (paths: string[], index: number) => {
      let at = index

      for (const path of paths) {
        at += await annotations.insertFile(
          path,
          at,
          documentRef.current?.numPages ?? 0,
        )
      }
    },
    [annotations],
  )

  // A PDF dragged in from the desktop, handed down by the window's one drag
  // handler (see `App.tsx`). The thumbnail grid is the only surface that takes
  // one: it is where a position can be pointed at — the page views show one page
  // at a time and no gaps — so anywhere else the drag is left to the workspace,
  // which opens the file as a tab of its own.
  const handleFileDrag = useCallback(
    (event: FileDragEvent): boolean => {
      const viewer = viewerRef.current

      if (
        event.kind === "leave" ||
        !active ||
        !viewer ||
        viewMode !== "thumbnail"
      ) {
        setFileDropIndex(null)
        return false
      }

      // A drag this document could not take is left to the workspace, whose
      // full-window target says honestly that the file opens rather than lands:
      // an insertion line drawn for a folder promises a place it will refuse.
      // Null paths mean the window never heard them, not that there are none.
      if (!(event.paths?.some(isPdfPath) ?? true)) {
        setFileDropIndex(null)
        return false
      }

      // Resolved from the point every time, drop included: the index the line
      // was drawn at belongs to the render that drew it, and a file must land
      // where the pointer is, not where it was.
      const index = insertIndexForHit(
        dropHitAt(event.point, viewer),
        event.point.x,
      )

      setFileDropIndex(event.kind === "over" ? index : null)

      if (index === null) {
        return false
      }

      if (event.kind === "over") {
        return true
      }

      // Claimed either way: the drag was over this document's grid, so a drop it
      // cannot act on is an error to show here, not a tab to open behind the
      // reader's back. A page-shifting edit in flight is the one such case —
      // the gap was read off a grid that edit is about to renumber.
      if (annotations.isStructureBusyNow()) {
        setViewerError("editInFlight")
      } else {
        void insertFiles(event.paths.filter(isPdfPath), index)
      }

      return true
    },
    [active, annotations, insertFiles, viewMode],
  )

  // A drag the reader started here but finished elsewhere — they switched tabs
  // while a file was in the air, or the wizard took the drop — never sends this
  // session a `leave`, so the line it drew would outlive the drag.
  useEffect(() => {
    if (!active) {
      setFileDropIndex(null)
    }
  }, [active])

  useImperativeHandle(
    ref,
    () => ({ hasUnsavedWorkNow, onFileDrag: handleFileDrag }),
    [handleFileDrag, hasUnsavedWorkNow],
  )

  // Each mode stacks its pages to a different total height, and the viewer keeps
  // its scroll offset across the switch, so the old offset would land somewhere
  // unrelated. Remember the page being read and seek back to it instead. Queued
  // here rather than from the commit below so that the layout effects of the
  // very next render already see the seek pending, and yield the offset to it.
  const changeViewMode = (mode: ViewMode) => {
    if (mode !== viewMode) {
      pendingScrollPageRef.current = currentPage
    }

    if (mode === "single" || mode === "book") {
      setBookmarksOpen(false)
    }

    setPreferredViewMode(mode)
  }

  // The same seek for the switch nobody pressed: a merge past a one-page
  // document's first spread brings book view back on its own. A seek already
  // queued — the press above, or a thumbnail opened at its own page — is the
  // more specific target and stands.
  useEffect(() => {
    if (laidOutViewModeRef.current === viewMode) {
      return
    }

    laidOutViewModeRef.current = viewMode

    if (pendingScrollPageRef.current === null) {
      pendingScrollPageRef.current = currentPage
    }
  }, [currentPage, viewMode])

  // The target only exists once the new layout has mounted, so the scroll waits
  // for the commit rather than running alongside the mode change — or, for a
  // tab returning to a window that was resized without it, the new geometry.
  useEffect(() => {
    const pendingPage = pendingScrollPageRef.current
    const viewer = viewerRef.current

    if (pendingPage === null || !viewer) {
      return
    }

    // The jump reads as a view swap rather than a scroll, so it lands instantly.
    scrollToPage(pendingPage, "auto")

    const committed = committedSizeRef.current

    // Leaving the thumbnail grid closes the bookmark sidebar in the same commit,
    // which widens the viewer — and the zoom that sizes every page only follows
    // once that width has been committed, growing the pages under a scroll
    // offset already taken. Keep the page until the layout the seek measured is
    // the settled one, so the last seek is the one that stands.
    if (
      viewer.clientWidth === committed.width &&
      viewer.clientHeight === committed.height
    ) {
      pendingScrollPageRef.current = null
    }
  }, [viewerHeight, viewerWidth, viewMode])

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

  /**
   * Fetches the fallback face, then re-runs the edit that wanted it.
   *
   * The retry is the whole point: by now the note's text is in `unfontedEdit`
   * and nowhere else. A failed fetch leaves it there and keeps the offer on
   * screen, so it can be taken again rather than costing the reader what they
   * typed.
   */
  const fetchNoteFont = useCallback(async () => {
    setFetchingNoteFont(true)

    // Only the fetch is caught here: an edit that fails after it reports
    // through `onAnnotateError`, and reading that as a download failure would
    // send the reader to check a connection that had just worked.
    try {
      await invoke("download_pdf_note_font")
    } catch {
      setViewerError("noteFontFailed")

      return
    } finally {
      setFetchingNoteFont(false)
    }

    setViewerError(null)

    // Let go before the retry rather than after: an edit that wants a face
    // again comes back through `onAnnotateError`, which is what puts it back.
    if (unfontedEdit) {
      setUnfontedEdit(null)
      await annotations.commit(unfontedEdit)
    }
  }, [annotations, unfontedEdit])

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
                : viewerError === "editInFlight"
                  ? t("annotate.dropWhileEditing")
                  : viewerError === "noteFontMissing"
                    ? t("annotate.noteFontMissing")
                    : viewerError === "noteFontFailed"
                      ? t("annotate.noteFontFailed")
                      : null

  return (
    <div
      aria-hidden={!active}
      aria-labelledby={tabElementId(openedDocument.id)}
      className="h-svh overflow-hidden bg-background"
      data-active={active}
      data-document-session={openedDocument.id}
      hidden={!active}
      id={panelElementId(openedDocument.id)}
      role="tabpanel"
    >
      {/* pb-px keeps the content box an even height: without it the bottom
          border leaves 47px, and centring a 32px control there puts its own
          border on a half pixel, which the WebView rounds per element — some
          outlines paint 1px solid, others two half-intensity rows. */}
      <header
        className="fixed inset-x-0 top-0 z-50 grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b bg-background/95 px-2 pb-px shadow-xs backdrop-blur"
        data-tauri-drag-region="deep"
      >
        <div
          className={cn(
            "flex items-center gap-1 justify-self-start",
            macOS && "pl-[72px]",
          )}
        >
          {/* First in the header, ahead of the document tools: the menu is the
              window's, not this document's, and it sits in the same place on
              the home tab. */}
          {active ? (
            <AppMenu
              {...menu}
              canSave={canSave}
              onSave={() => void annotations.save()}
              onSaveAs={() => void exportPdf()}
              saveHint={saveHint}
            />
          ) : null}
          <ToolbarTooltip label={bookmarksLabel}>
            <Toggle
              aria-label={bookmarksLabel}
              className="size-8"
              disabled={!pdfDocument || !bookmarksApply}
              onPressedChange={setBookmarksOpen}
              pressed={bookmarksOpen}
              variant="outline"
            >
              <Bookmark className={bookmarksOpen ? "fill-current" : undefined} />
            </Toggle>
          </ToolbarTooltip>
          <HistoryControls
            canRedo={annotations.canRedo}
            canUndo={annotations.canUndo}
            disabled={!pdfDocument}
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
            onUndo={() => {
              const target = annotations.historyNow().past.at(-1)?.command
              if (target && movesPages(target)) {
                cancelTextNote()
              }
              void annotations.undo()
            }}
          />
          <ViewModeToggle
            bookApplies={bookApplies}
            disabled={!pdfDocument}
            onChange={changeViewMode}
            value={viewMode}
          />
          {zoomApplies ? (
            <ZoomControls
              canZoomIn={zoom.canZoomIn}
              canZoomOut={zoom.canZoomOut}
              disabled={!pdfDocument}
              onToggleFit={zoom.toggleFit}
              onZoomIn={zoom.zoomIn}
              onZoomOut={zoom.zoomOut}
              zoomMode={zoom.zoomMode}
              zoomPercent={zoom.zoomPercent}
            />
          ) : null}
          <ToolbarTooltip label={t("toolbar.rotate")}>
            <Button
              aria-label={t("toolbar.rotate")}
              disabled={!pdfDocument}
              onClick={() => setRotation((value) => (value + 90) % 360)}
              size="icon"
              variant="outline"
            >
              <RotateCw />
            </Button>
          </ToolbarTooltip>
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

        <div className="flex items-center gap-1 justify-self-end">
          <AnnotationToolbar
            activeTool={activeTool}
            disabled={!pdfDocument}
            eraserApplies={drawingApplies}
            highlightApplies={drawingApplies}
            highlightColor={highlightColor}
            onHighlightColorChange={changeHighlightColor}
            onMergeWizard={menu.onMergeWizard}
            onPageNumbers={pageNumbers.openDialog}
            onRectStyleChange={changeRectStyle}
            onToolChange={setActiveTool}
            onWatermark={watermark.openDialog}
            rectApplies={drawingApplies}
            rectStyle={rectStyle}
            textNoteApplies={drawingApplies}
          />
          {active && !macOS ? <WindowControls /> : null}
        </div>
      </header>

      <div className="flex h-full pt-21">
        {pdfDocument && bookmarksOpen ? (
          <BookmarkSidebar
            items={pdfDocument.outline}
            onNavigate={scrollToPage}
          />
        ) : null}

        {/* The viewer's own scroll box cannot host the zoom readout — anything
            absolute inside it is placed against the scrolled content and would
            drift off the middle of the screen. This box holds still around it. */}
        <div className="relative min-w-0 flex-1">
          <main
            className={cn(
              "relative size-full overflow-auto bg-zinc-200/70 dark:bg-zinc-950",
              // Only while the tool can actually draw: the thumbnail grid hides
              // the toggle that would turn it back off, so a crosshair left over
              // it would promise a drag that does nothing.
              drawingRect && "cursor-crosshair",
              drawingTextNote && "cursor-text",
              // The eraser aims at a mark rather than at a point of the page,
              // so it takes the same aiming pointer the rectangle draws with.
              erasing && "cursor-crosshair",
            )}
            ref={viewerRef}
          >
            <PdfViewerLayout
              currentPage={currentPage}
              documentId={pdfDocument.id}
              draft={rectDraft ?? undefined}
              fileName={fileName}
              key={pdfDocument.id}
              pageEdit={{
                fileDropIndex,
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
          </main>
          {zoomApplies ? (
            <ZoomIndicator flash={zoom.zoomRequest} percent={zoom.zoomPercent} />
          ) : null}
        </div>
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
        isStopping={watermark.isStopping}
        onApply={() => void watermark.apply()}
        onDraftChange={watermark.setDraft}
        onOpenChange={watermark.onOpenChange}
        onRemove={() => void watermark.remove()}
        onStop={watermark.stop}
        open={active && watermark.open}
        progress={watermark.progress}
        validationError={watermark.validationError}
      />

      <PageNumbersDialog
        draft={pageNumbers.draft}
        hasPageNumbers={pageNumbers.hasPageNumbers}
        isApplying={pageNumbers.isApplying}
        isStopping={pageNumbers.isStopping}
        onApply={() => void pageNumbers.apply()}
        onDraftChange={pageNumbers.setDraft}
        onOpenChange={pageNumbers.onOpenChange}
        onRemove={() => void pageNumbers.remove()}
        onStop={pageNumbers.stop}
        open={active && pageNumbers.open}
        pageCount={pdfDocument?.numPages ?? 0}
        progress={pageNumbers.progress}
        validationError={pageNumbers.validationError}
      />

      {errorMessage ? (
        <div
          className="fixed top-25 right-4 z-40 flex max-w-80 items-center gap-3 rounded-lg border border-destructive/20 bg-background px-4 py-2 text-sm text-destructive shadow-lg"
          role="alert"
        >
          <span>{errorMessage}</span>
          {/* The only refusals the reader can answer from here, so the only
              ones that carry a button — a fetch that failed included, since
              the edit waiting on it is still held. */}
          {viewerError === "noteFontMissing" ||
          viewerError === "noteFontFailed" ? (
            <Button
              className="shrink-0"
              disabled={fetchingNoteFont}
              onClick={() => void fetchNoteFont()}
              size="sm"
              variant="outline"
            >
              {fetchingNoteFont
                ? t("annotate.noteFontFetching")
                : t("annotate.noteFontFetch")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})
