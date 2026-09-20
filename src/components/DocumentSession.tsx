import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"

import type { AppMenuActions } from "@/components/AppMenu"
import { CompressExportDialog } from "@/components/CompressExportDialog"
import { ImageExportDialog } from "@/components/ImageExportDialog"
import { SplitPdfDialog } from "@/components/SplitPdfDialog"
import { BookmarkSidebar } from "@/components/BookmarkSidebar"
import { PdfSearch } from "@/components/PdfSearch"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { SessionDialogs } from "@/components/SessionDialogs"
import { SessionHeader } from "@/components/SessionHeader"
import { TextNoteEditor } from "@/components/TextNoteEditor"
import { ZoomIndicator } from "@/components/ZoomIndicator"
import type { AnnotationTool } from "@/components/AnnotationToolbar"
import { useAnnotations } from "@/hooks/useAnnotations"
import { useCurrentPageTracker } from "@/hooks/useCurrentPageTracker"
import { useDocumentNotices, type NoticeChannel } from "@/hooks/useNotices"
import { usePageClipboard } from "@/hooks/usePageClipboard"
import { usePrint } from "@/hooks/usePrint"
import { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import type { PageHandoffTarget } from "@/hooks/usePageHandoff"
import { useDocumentSearch } from "@/hooks/useDocumentSearch"
import { useEraserTool } from "@/hooks/useEraserTool"
import { useGridDrop } from "@/hooks/useGridDrop"
import { useHighlightTool } from "@/hooks/useHighlightTool"
import { usePageNumbers } from "@/hooks/usePageNumbers"
import { useRecentView } from "@/hooks/useRecentView"
import { useRectTool } from "@/hooks/useRectTool"
import { useTextNoteTool } from "@/hooks/useTextNoteTool"
import { useTextSelectAll } from "@/hooks/useTextSelectAll"
import { useThumbnailPageOps } from "@/hooks/useThumbnailPageOps"
import { useViewerViewport } from "@/hooks/useViewerViewport"
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
import { copyPlainText } from "@/lib/clipboard"
import { hasLayerOverWorkspace } from "@/lib/contextMenu"
import { panelElementId, tabElementId } from "@/lib/documentTabs"
import { documentPlainText } from "@/lib/documentText"
import { documentRefusals } from "@/lib/notices"
import {
  formatPageRanges,
  type PageClipboard,
} from "@/lib/pageClipboard"
import type { PageHandoff } from "@/lib/pageDrag"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import {
  type PdfDocumentInfo,
  type PdfExportOutcome,
  type PdfStructureUpdate,
} from "@/lib/pdf"
import {
  rotationForPage,
  rotationsForPageCount,
  rotationsAfterRotate,
} from "@/lib/pageRotation"
import { isMacOS } from "@/lib/platform"
import type {
  MovedSessionSnapshot,
  MovedTabSeed,
} from "@/lib/tabMove"
import type { PdfOwnedLayerProgressHandler } from "@/lib/progress"
import { type RecentPdfView } from "@/lib/recentFiles"
import {
  defaultViewMode,
  effectiveViewMode,
  hasBookSpread,
  pageTurnTarget,
  readStoredViewMode,
  spreadPages,
  storeViewMode,
  type ViewMode,
} from "@/lib/viewMode"
import { isNoteWorthKeeping } from "@/lib/textNoteDraft"
import { anchorCorrection, anchorOnPage } from "@/lib/viewportAnchor"
import type { WatermarkConfig } from "@/lib/watermark"
import { CONTENT_PADDING_X, CONTENT_PADDING_Y } from "@/lib/zoom"

/** A file dragged in from the desktop: points in CSS pixels, and `over` with
    null paths when the OS never named them to this window. */
export type FileDragEvent =
  | { kind: "over"; paths: string[] | null; point: { x: number; y: number } }
  | { kind: "drop"; paths: string[]; point: { x: number; y: number } }
  | { kind: "leave" }

/**
 * Pages dragged out of another document's grid, as the workspace passes them
 * down; only the drop names the pages, there being nothing yet to do with them.
 */
export type PageDragEvent =
  | { kind: "over"; point: { x: number; y: number } }
  | {
      kind: "drop"
      pages: number[]
      point: { x: number; y: number }
      sourceDocumentId: number
    }
  | { kind: "leave" }

export type DocumentSessionHandle = {
  /** Lets go of the edit it held: the note's text lives nowhere else by then. */
  dismissNoteFont: () => void
  fetchNoteFont: () => void
  hasUnsavedWorkNow: () => boolean
  openPageNumbers: () => void
  openSearch: () => void
  openWatermark: () => void
  print: () => void
  rememberViewNow: () => Promise<void>
  /** Everything only this session knows about the tab it shows, for a move to
      another window — or why the move must wait, and null where there is no
      document behind the tab. */
  snapshotForMove: () => MovedSessionSnapshot | null
  /** Refuses wherever the toolbar's button is greyed out, so no key can write
      what it will not. */
  save: () => void
  saveAs: () => void
  selectAll: () => void
  undo: () => void
  /** True only over this session's thumbnail grid, where a dropped PDF is
      inserted at the gap under the pointer instead of opening as a tab. */
  onFileDrag: (event: FileDragEvent) => boolean
  /** The same answer for pages dragged from another document's grid, which land
      in the gap under the pointer as copies — their source keeps them. */
  onPageDrag: (event: PageDragEvent) => boolean
  /** Called for a drag the workspace has just brought here: the grid is the
      one view a page can be dropped into. */
  showThumbnails: () => void
}

type DocumentSessionProps = {
  active: boolean
  document: PdfDocumentInfo
  fileName: string
  /** Whether this app-created document has yet to be written to its first
      file. It remains unsaved even before the reader makes another edit. */
  initialSaveRequired?: boolean
  /** Page numbers to lay on as the session opens — the merge wizard's ask, run
      through the ordinary command so they stay one undo away. */
  initialPageNumbers?: PageNumbersConfig | null
  /** A path-backed document's last reading view. */
  initialRecentView?: RecentPdfView
  /** Overrides the stored preference where another view suits the document: a
      merge opens on the thumbnail grid, where the whole result can be seen. */
  initialViewMode?: ViewMode
  /** Reports the merge wizard's initial page-content work while it stays open. */
  onInitialLayerProgress?: PdfOwnedLayerProgressHandler
  /** Resolves the merge wizard once all requested initial layers have settled. */
  onInitialLayersSettled?: () => void
  /** A watermark to lay on as the session opens — see `initialPageNumbers`. */
  initialWatermark?: WatermarkConfig | null
  /** The workspace half of the header's menu, which every tab shares. */
  menu: AppMenuActions
  /** Where this session says what happened. Write-only, and bound to this
      document below, so a session cannot speak for another's tab. */
  notices: NoticeChannel
  onDirtyChange: (documentId: number, dirty: boolean) => void
  /** Whether this document may now be written back over its own file. Only the
      session can say: the workspace cannot see what makes it export-only. */
  onSavableChange: (documentId: number, canSave: boolean) => void
  /** An export that gave a document its first file: the tab now stands for
      that file, not for the bytes it opened from. */
  onSourceChange: (documentId: number, path: string) => void
  /** The workspace's answer for a page drag that has left this document's grid,
      and the way another document's pages reach it. */
  pageHandoff: PageHandoffTarget
  recentPath?: string
  saveAsDefaultName?: string
  /** A tab that arrived from another window, replayed here: the state the
      strip could not carry, read once at the first mount. */
  movedSeed?: MovedTabSeed
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
      initialRecentView,
      initialSaveRequired = false,
      initialViewMode,
      initialWatermark,
      menu,
      notices,
      onInitialLayerProgress,
      onInitialLayersSettled,
      onDirtyChange,
      onSavableChange,
      onSourceChange,
      pageHandoff,
      recentPath,
      saveAsDefaultName,
      movedSeed,
    },
    ref,
  ) {
    const { t } = useTranslation()
    const macOS = isMacOS()
    const [pdfDocument, setPdfDocument] = useState<PdfDocumentInfo>(openedDocument)
    const [saveRequired, setSaveRequired] = useState(initialSaveRequired)
    const saveRequiredRef = useRef(initialSaveRequired)
    // Thumbnail canvases follow their pages through a reorder, including undo.
    // Other structure edits keep the existing position-based invalidation.
    const [thumbnailIdentity, setThumbnailIdentity] = useState(() => ({
      keys: openedDocument.pages.map((_, index) => index),
      nextKey: openedDocument.numPages,
    }))
    // Pages another file brought in leave the document export-only, like a
    // watermark. The backend answers with every structure update, so no replay.
    const [hasMergedPages, setHasMergedPages] = useState(
      () => movedSeed?.hasMergedPages ?? false,
    )
    const [currentPage, setCurrentPage] = useState(() =>
      Math.min(
        Math.max(initialRecentView?.position.pageNumber ?? 1, 1),
        Math.max(openedDocument.numPages, 1),
      ),
    )
    const [pageInput, setPageInput] = useState(() => String(currentPage))
    // The odometer stands in for the field's own text, and has to stand aside
    // while what the field holds is no longer the page being read.
    const [pageInputFocused, setPageInputFocused] = useState(false)
    const [pageRotations, setPageRotations] = useState<number[]>(
      () => movedSeed?.pageRotations ?? openedDocument.pages.map(() => 0),
    )
    const [bookmarksOpen, setBookmarksOpen] = useState(false)
    const [imageExportOpen, setImageExportOpen] = useState(false)
    const [splitOpen, setSplitOpen] = useState(false)
    const [compressOpen, setCompressOpen] = useState(false)
    // The one notice this session holds rather than raises: it stands until the
    // reader answers it, and the held edit below is what the answer is for.
    const [noteFontOffer, setNoteFontOffer] = useState<
      "noteFontFailed" | "noteFontMissing" | null
    >(null)
    /**
     * The edit that failed for want of a face, kept so accepting the download can
     * re-run it: a note's text lives nowhere else by then.
     */
    const [unfontedEdit, setUnfontedEdit] = useState<AnnotationCommand | null>(
      null,
    )
    const [fetchingNoteFont, setFetchingNoteFont] = useState(false)
    const [preferredViewMode, setPreferredViewMode] = useState<ViewMode>(
      () =>
        initialViewMode ??
        initialRecentView?.viewMode ??
        readStoredViewMode() ??
        defaultViewMode,
    )
    // Tracking and persistence wait until the saved point is back: the first,
    // temporary layout would otherwise replace the position being restored.
    const [restoringRecentView, setRestoringRecentView] = useState(
      initialRecentView !== undefined,
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
    const initialRecentPositionRef = useRef(
      initialRecentView
        ? {
            ...initialRecentView.position,
            pageNumber: Math.min(
              initialRecentView.position.pageNumber,
              Math.max(openedDocument.numPages, 1),
            ),
          }
        : null,
    )
    // The tracked page, for effects bound once: they cannot read a value that
    // re-renders.
    const currentPageRef = useRef(currentPage)
    const mountedRef = useRef(false)
    // Which offer a fetch in flight belongs to. A download cannot be called
    // back, so what it returns to is checked against this instead.
    const noteFontOfferRef = useRef(0)
    const notice = useDocumentNotices(notices, openedDocument.id)
    // The offer and the edit it holds go together: once it is off the screen
    // there is no way back, and a kept edit would only be re-run by the next.
    const clearNoteFontOffer = useCallback(() => {
      noteFontOfferRef.current += 1
      setNoteFontOffer(null)
      setUnfontedEdit(null)
    }, [])
    // A refusal that outlived what it described would sit over every mark the
    // reader went on to make successfully.
    const clearEditRefusals = useCallback(() => {
      clearNoteFontOffer()
      notice.retract(documentRefusals)
    }, [clearNoteFontOffer, notice])

    const bookApplies = hasBookSpread(pdfDocument.numPages)
    const viewMode = effectiveViewMode(preferredViewMode, pdfDocument.numPages)

    // The grid has no single scale for a zoom to act on. The controls are absent
    // rather than disabled: disabled is what an unopened document means.
    const zoomApplies = viewMode === "single" || viewMode === "book"
    const bookmarksApply = viewMode === "thumbnail"

    const scrollToPage = useCallback(
      (pageNumber: number, behavior: ScrollBehavior = "smooth") => {
        const page = viewerRef.current?.querySelector<HTMLElement>(
          `[data-page-number="${pageNumber}"]`,
        )

        setCurrentPage(pageNumber)
        page?.scrollIntoView({ behavior, block: "start" })
      },
      [],
    )

    const viewport = useViewerViewport({
      active,
      currentPage,
      currentPageRef,
      restoringRecentView,
      scrollToPage,
      viewMode,
      viewerRef,
    })
    const { committedSizeRef, pendingScrollPageRef, viewerHeight, viewerWidth } = viewport

    const zoom = useZoom({
      contentHeight: Math.max(0, viewerHeight - CONTENT_PADDING_Y),
      contentWidth: Math.max(0, viewerWidth - CONTENT_PADDING_X),
      currentPage,
      disabled: !active || !zoomApplies,
      initialZoom: initialRecentView
        ? {
            ...initialRecentView.zoom,
            fitPage: Math.min(
              initialRecentView.zoom.fitPage,
              Math.max(openedDocument.numPages, 1),
            ),
          }
        : undefined,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      viewMode,
      viewerRef,
    })
    // Every drawing tool needs a page under the pointer, which the grid does not
    // show; the watermark and page numbers act on the document, so they stay.
    const drawingApplies = viewMode === "single" || viewMode === "book"
    // In the thumbnail grid a click is a selection, so the grid doubles as the
    // page-editing surface; leaving it clears what was chosen.
    const thumbnailSelection = useThumbnailSelection({
      active: active && viewMode === "thumbnail",
      numPages: pdfDocument.numPages,
    })
    const clearThumbnailSelection = thumbnailSelection.clear
    // The paste's own work needs the history below, which is set up after this;
    // the hook only ever calls it from a keypress, by which time it is here.
    const pastePagesRef = useRef<(index: number) => void>(() => {})
    const pageClipboard = usePageClipboard({
      active: active && viewMode === "thumbnail",
      onPaste: useCallback((index: number) => pastePagesRef.current(index), []),
      onTaken: useCallback(
        (taken: PageClipboard) =>
          notice.raise(taken.mode === "cut" ? "pagesCut" : "pagesCopied", {
            values: {
              count: taken.pages.length,
              pages: formatPageRanges(taken.pages),
            },
          }),
        [notice],
      ),
      selectedPages: thumbnailSelection.selectedPages,
    })
    const pageClipboardStructureChanged = pageClipboard.structureChanged
    const { clipboard } = pageClipboard
    // Only a cut marks its pages in the grid: a copy takes nothing away, so the
    // pages it named go on reading as the pages they are.
    const cutThumbnailPages = useMemo(
      () => new Set(clipboard?.mode === "cut" ? clipboard.pages : []),
      [clipboard],
    )
    // Fetched as the selection is made, not when the copy asks: the clipboard
    // write must land inside its keypress, and a long document's text is slow.
    const selectedText = useRef<Promise<string> | null>(null)
    const copyDocumentText = useCallback(() => {
      const pending =
        selectedText.current ??
        documentPlainText(pdfDocument.id, pdfDocument.numPages)

      selectedText.current = pending
      void pending.then(copyPlainText)
    }, [pdfDocument.id, pdfDocument.numPages])
    // The page views' half of a select-all; the grid's half is the selection
    // above, and the view in front decides which of the two answers.
    const textSelectAll = useTextSelectAll({
      active: active && viewMode !== "thumbnail",
      onCopy: copyDocumentText,
    })

    useEffect(() => {
      selectedText.current = textSelectAll.selectedAll
        ? documentPlainText(pdfDocument.id, pdfDocument.numPages)
        : null
    }, [pdfDocument.id, pdfDocument.numPages, textSelectAll.selectedAll])
    const selectAllPages = thumbnailSelection.selectAll
    const selectAllText = textSelectAll.selectAll
    // Where the workspace's select-all shortcut lands: the grid holds pages, and
    // the page views hold the text laid over them.
    const selectAll = useCallback(() => {
      if (viewMode === "thumbnail") {
        selectAllPages()
      } else {
        selectAllText()
      }
    }, [selectAllPages, selectAllText, viewMode])
    const annotations = useAnnotations({
      documentId: pdfDocument?.id,
      initial: movedSeed && { history: movedSeed.history, marks: movedSeed.marks },
      onAnnotateError: useCallback(
        (error?: unknown, command?: AnnotationCommand) => {
          // The one refusal with a way out: nothing installed can draw this text,
          // and the reader can fetch something that will.
          if (isNoteFontMissing(error)) {
            setUnfontedEdit(command ?? null)
            setNoteFontOffer("noteFontMissing")
            return
          }

          notice.raise("annotateFailed")
        },
        [notice],
      ),
      onExportError: useCallback(
        () => notice.raise("exportFailed"),
        [notice],
      ),
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
          saveRequiredRef.current = false
          setSaveRequired(false)
          documentRef.current = next
          setPdfDocument(next)
          onSourceChange(documentId, outcome.path)
        },
        [onSourceChange],
      ),
      onSaveError: useCallback(
        () => notice.raise("saveFailed"),
        [notice],
      ),
      // A structure command replaces the page list wholesale; where it moved the
      // pages, bring each position-derived state back into range.
      onStructureChange: useCallback(
        (
          documentId: number,
          update: PdfStructureUpdate,
          movement?: number[] | "inPlace",
        ) => {
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

          // Turned where it stands, so every position still holds its page — a
          // second press of the rotation must still find the selection it turns.
          if (movement === "inPlace") {
            return
          }

          setThumbnailIdentity(({ keys, nextKey }) =>
            movement
              ? { keys: movement.map((page) => keys[page - 1]!), nextKey }
              : {
                  keys: update.pages.map((_, index) => keys[index] ?? nextKey + index),
                  nextKey: nextKey + update.numPages,
                },
          )
          setCurrentPage((page) =>
            Math.min(Math.max(page, 1), Math.max(1, update.numPages)),
          )
          clearThumbnailSelection()
          // The page numbers on the clipboard now name other pages — unless this
          // is the paste's own insert, which says how far they slid.
          pageClipboardStructureChanged(update.numPages)
          setPageRotations((rotations) =>
            rotationsForPageCount(rotations, update.numPages),
          )
        },
        [clearThumbnailSelection, pageClipboardStructureChanged],
      ),
      onSuccess: clearEditRefusals,
    })

    const search = useDocumentSearch({
      active,
      currentPageRef,
      documentId: pdfDocument?.id,
      documentPages: pdfDocument.pages,
      onMatchInGrid: useCallback((pageNumber: number) => {
        pendingScrollPageRef.current = pageNumber
        setBookmarksOpen(false)
        setPreferredViewMode("single")
      }, []),
      sessionId: openedDocument.id,
      setCurrentPage,
      textEpochs: annotations.textEpochs,
      viewerRef,
      viewMode,
    })

    const gridDrop = useGridDrop({
      active,
      annotations,
      documentRef,
      notice,
      viewMode,
      viewerRef,
    })

    const pageOps = useThumbnailPageOps({
      annotations,
      pageClipboard,
      pendingScrollPageRef,
      pdfDocument,
      notice,
      setBookmarksOpen,
      setPreferredViewMode,
      thumbnailSelection,
    })
    const {
      deleteThumbnailPage,
      insertBlankPage,
      menuThumbnailPage,
      openThumbnailPage,
      pastePages,
      reorderPages,
      rotateThumbnailPages,
      selectThumbnailPage,
    } = pageOps

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
    // Named apart from the hooks so the window's keys and the toolbar's buttons
    // open the one dialog; both openers are stable.
    const openWatermarkDialog = watermark.openDialog
    const openPageNumbersDialog = pageNumbers.openDialog
    // Printed as the reader has it turned: the rotation is the viewer's own, and
    // the backend's render of a page knows nothing about it.
    const rotationAt = useCallback(
      (pageNumber: number) => rotationForPage(pageRotations, pageNumber),
      [pageRotations],
    )
    const print = usePrint({
      documentId: pdfDocument?.id,
      onError: () => notice.raise("printFailed"),
      pages: pdfDocument?.pages ?? [],
      rotationAt,
    })
    const discardPrint = print.discard
    const startPrint = print.start

    // Only the tab on screen keeps a sheet: print media would otherwise run
    // every open document's pages together, and each holds its pages as images.
    useEffect(() => {
      if (!active) {
        discardPrint()
      }
    }, [active, discardPrint])

    const textSelectionDragging = useHighlightTool({
      active: active && drawingApplies && activeTool === "highlight",
      color: highlightColor,
      onCommit: annotations.commit,
      opacity: HIGHLIGHT_OPACITY,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      selectable:
        active &&
        drawingApplies &&
        (activeTool === null || activeTool === "highlight"),
      viewerRef,
    })

    const drawingRect = drawingApplies && activeTool === "rect"
    const rectTool = useRectTool({
      active: active && drawingRect,
      onCommit: annotations.commit,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      style: rectStyle,
      viewerRef,
    })

    const erasing = drawingApplies && activeTool === "eraser"
    useEraserTool({
      active: active && erasing,
      onErase: annotations.eraseAt,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      viewerRef,
    })

    const drawingTextNote = drawingApplies && activeTool === "textNote"
    const textNote = useTextNoteTool({
      active: drawingTextNote,
      onCommit: annotations.commit,
      suspended: !active,
      pages: pdfDocument.pages,
      rotations: pageRotations,
      style: textNoteStyle,
      viewerRef,
    })

    // Keyed to the `[data-tool-cursor]` rules in `index.css`; null wherever a
    // tool would not draw, so the reader gets the plain pointer back.
    const toolCursor = drawingApplies ? activeTool : null

    // Both drawing tools hold previews that only a page's own paint may retire;
    // each ignores a paint covering nothing of its own.
    const retireRectPreviews = rectTool.onPagePaint
    const retireNotePreviews = textNote.onPagePaint
    const onPagePaint = useCallback(
      (pageNumber: number, renderEpoch: number) => {
        retireRectPreviews(pageNumber, renderEpoch)
        retireNotePreviews(pageNumber, renderEpoch)
      },
      [retireNotePreviews, retireRectPreviews],
    )

    const draftDirty = isNoteWorthKeeping(textNote.draft?.text ?? "")
    const hasUnsavedWorkNow = useCallback(
      () =>
        saveRequiredRef.current ||
        annotations.isDirtyNow() ||
        annotations.hasPendingWorkNow() ||
        isNoteWorthKeeping(textNote.draft?.text ?? ""),
      [annotations, textNote.draft?.text],
    )

    useEffect(() => {
      onDirtyChange(
        openedDocument.id,
        saveRequired || annotations.isDirty || draftDirty,
      )
    }, [
      annotations.isDirty,
      draftDirty,
      onDirtyChange,
      openedDocument.id,
      saveRequired,
    ])

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
        saveAsDefaultName ?? t("menu.untitled"),
        t("annotate.exportFilter"),
      )
    }, [annotations, pdfDocument, saveAsDefaultName, t])

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

    // Applied once: the wizard's steps through the ordinary commands, so the
    // reader can undo either. Numbers first, so the watermark lands above them.
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

    // Restored against the first real layout, once size and saved zoom have both
    // sized the pages; normalized, so a new window size stays a useful position.
    useLayoutEffect(() => {
      const position = initialRecentPositionRef.current
      const viewer = viewerRef.current

      if (!restoringRecentView || !active || !position || !viewer) {
        return
      }

      const committed = committedSizeRef.current

      if (
        viewerWidth <= 0 ||
        viewerHeight <= 0 ||
        viewer.clientWidth !== committed.width ||
        viewer.clientHeight !== committed.height
      ) {
        return
      }

      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${position.pageNumber}"]`,
      )
      const viewerRect = viewer.getBoundingClientRect()
      const pageRect = page?.getBoundingClientRect()

      if (!pageRect || pageRect.width <= 0 || pageRect.height <= 0) {
        return
      }

      const correction = anchorCorrection(
        {
          clientX: viewerRect.left + viewerRect.width / 2,
          clientY: viewerRect.top,
          fractionX: position.fractionX,
          fractionY: position.fractionY,
          pageNumber: position.pageNumber,
        },
        pageRect,
      )

      viewer.scrollLeft += correction.left
      viewer.scrollTop += correction.top
      initialRecentPositionRef.current = null
      setRestoringRecentView(false)
    }, [
      active,
      restoringRecentView,
      viewMode,
      viewerHeight,
      viewerWidth,
      zoom.scale,
    ])

    // A view this document was opened in rather than chosen in is not the
    // reader's preference, so it is not stored — only what they press after is.
    const viewModeChosen = useRef(
      initialViewMode === undefined && initialRecentView === undefined,
    )

    useEffect(() => {
      if (!viewModeChosen.current) {
        viewModeChosen.current = true
        return
      }

      storeViewMode(preferredViewMode)
    }, [preferredViewMode])

    // Undo and redo can move a note's anchored page out from under it and cannot
    // take the note as their target, so the uncommitted draft goes before a step.
    const cancelTextNote = textNote.cancel

    const undoStep = useCallback(() => {
      // The target is the head of the queue's live history, not the rendered one.
      const target = annotations.historyNow().past.at(-1)?.command

      if (target && movesPages(target)) {
        cancelTextNote()
      }

      void annotations.undo()
    }, [annotations, cancelTextNote])

    useCurrentPageTracker(
      viewerRef,
      active ? pdfDocument.id : undefined,
      viewMode,
      setCurrentPage,
      zoom.zoomPreviewing || restoringRecentView,
    )

    useEffect(() => {
      if (!active || viewMode === "thumbnail") {
        return
      }

      const handlePageTurn = (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          (event.key !== "PageUp" && event.key !== "PageDown") ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return
        }

        const eventTarget = event.target

        // A page key in a field or an open popup belongs to that UI, not to the
        // document behind it — a note draft or the field may be mid-edit.
        if (
          (eventTarget instanceof Element &&
            eventTarget.closest("input, textarea, select, [contenteditable]")) ||
          hasLayerOverWorkspace()
        ) {
          return
        }

        event.preventDefault()

        const current = currentPageRef.current
        const target = pageTurnTarget(
          current,
          pdfDocument.numPages,
          viewMode,
          event.key === "PageDown" ? 1 : -1,
        )
        const currentRow =
          viewMode === "book"
            ? (spreadPages(current, pdfDocument.numPages)[0] ?? current)
            : current

        // Consume the key at either edge too: the WebView's own handling would
        // reintroduce a partial viewport scroll within the first or last page.
        if (target === currentRow) {
          return
        }

        // A held key may repeat before React's effect mirrors state into this ref.
        // Advance it now so every repeat still turns exactly one page or spread.
        currentPageRef.current = target
        scrollToPage(target, "auto")
      }

      document.addEventListener("keydown", handlePageTurn)

      return () => {
        document.removeEventListener("keydown", handlePageTurn)
      }
    }, [active, pdfDocument.numPages, scrollToPage, viewMode])

    // Each mode stacks pages to a different height, so the kept offset would land
    // somewhere unrelated; queued here, ahead of the next render's layout effects.
    const changeViewMode = (mode: ViewMode) => {
      if (mode !== viewMode) {
        pendingScrollPageRef.current = currentPage
      }

      if (mode === "single" || mode === "book") {
        setBookmarksOpen(false)
      }

      setPreferredViewMode(mode)
    }

    const { queueRecentView, rememberViewNow: flushAndRememberView } = useRecentView({ recentPath })

    // The reading position as it stands, or null where nothing faithful can be
    // said: a hidden tab, a pending seek, or a layout the render has not caught
    // up with yet.
    const sampleCurrentView = useCallback((): RecentPdfView | null => {
      const viewer = viewerRef.current

      if (
        !active ||
        !recentPath ||
        restoringRecentView ||
        zoom.zoomPreviewing ||
        viewerWidth <= 0 ||
        viewerHeight <= 0 ||
        pendingScrollPageRef.current !== null ||
        !viewer
      ) {
        return null
      }

      const committed = committedSizeRef.current

      if (
        viewer.clientWidth !== committed.width ||
        viewer.clientHeight !== committed.height
      ) {
        return null
      }

      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${currentPage}"]`,
      )
      const viewerRect = viewer.getBoundingClientRect()
      const pageRect = page?.getBoundingClientRect()
      const anchor = pageRect
        ? anchorOnPage(
            currentPage,
            pageRect,
            viewerRect.left + viewerRect.width / 2,
            viewerRect.top,
          )
        : null

      if (!anchor) {
        return null
      }

      return {
        position: {
          fractionX: anchor.fractionX,
          fractionY: anchor.fractionY,
          pageNumber: anchor.pageNumber,
        },
        viewMode: preferredViewMode,
        zoom: { ...zoom.zoomState },
      }
    }, [
      active,
      currentPage,
      pdfDocument.pages,
      preferredViewMode,
      restoringRecentView,
      pageRotations,
      recentPath,
      viewMode,
      viewerHeight,
      viewerWidth,
      zoom.zoomPreviewing,
      zoom.zoomState,
    ])

    const rememberCurrentView = useCallback(() => {
      const view = sampleCurrentView()

      if (view) {
        queueRecentView(view)
      }
    }, [queueRecentView, sampleCurrentView])

    const rememberViewNow = useCallback(
      () => flushAndRememberView(sampleCurrentView),
      [flushAndRememberView, sampleCurrentView],
    )

    // What the tab takes with it: the structure as this session holds it (the
    // tab's own copy went stale with every edit), the view it is being read in,
    // the first-save wait as the session — not the tab it was opened with —
    // now stands, and the history-backed state a fresh session cannot derive.
    // A move waits while a note draft is open (its text lives nowhere else)
    // or work is in flight.
    const snapshotForMove = useCallback((): MovedSessionSnapshot | null => {
      const document = documentRef.current

      if (!document) {
        return null
      }

      if (isNoteWorthKeeping(textNote.draft?.text ?? "")) {
        return { blocked: "note" }
      }

      const annotationsSeed = annotations.snapshotForMove()

      if (!annotationsSeed) {
        return { blocked: "busy" }
      }

      return {
        document,
        recentView: sampleCurrentView(),
        saveRequired: saveRequiredRef.current,
        seed: {
          hasMergedPages,
          history: annotationsSeed.history,
          marks: annotationsSeed.marks,
          pageRotations,
          viewMode: preferredViewMode,
        },
      }
    }, [
      annotations,
      hasMergedPages,
      pageRotations,
      preferredViewMode,
      sampleCurrentView,
      textNote.draft?.text,
    ])

    useEffect(() => {
      const viewer = viewerRef.current

      if (!viewer) {
        return
      }

      viewer.addEventListener("scroll", rememberCurrentView, { passive: true })
      rememberCurrentView()

      return () => {
        viewer.removeEventListener("scroll", rememberCurrentView)
      }
    }, [rememberCurrentView])

    /**
     * The retry is the point: the note's text is in `unfontedEdit` and nowhere
     * else, so a failed fetch keeps both and the offer can be taken again.
     */
    const fetchNoteFont = useCallback(async () => {
      const offer = noteFontOfferRef.current

      setFetchingNoteFont(true)

      // Only the fetch is caught: an edit failing after it reports through
      // `onAnnotateError`, not as a download failure to blame a connection for.
      try {
        await invoke("download_pdf_note_font")
      } catch {
        // Silent where the offer is gone: it took the held edit with it, so
        // saying the fetch failed would put back an offer with nothing to retry.
        if (offer === noteFontOfferRef.current) {
          setNoteFontOffer("noteFontFailed")
        }

        return
      } finally {
        setFetchingNoteFont(false)
      }

      if (offer !== noteFontOfferRef.current) {
        return
      }

      setNoteFontOffer(null)

      // Let go before the retry rather than after: an edit that wants a face
      // again comes back through `onAnnotateError`, which is what puts it back.
      if (unfontedEdit) {
        setUnfontedEdit(null)
        await annotations.commit(unfontedEdit)
      }
    }, [annotations, unfontedEdit])

    // Owned page content (watermark, numbers) and merged pages leave a document
    // export-only; one opened from bytes has no file to write back to at all.
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
    // The toolbar's button has only its tooltip to carry the reason, so a
    // disabled save names it there rather than repeating the action's name.
    const saveLabel = !canSave && saveHint ? saveHint : t("annotate.save")

    // The window's save key runs the button's action, refusal included: a
    // watermarked or merged document may only ever be exported as a copy.
    const saveDocument = useCallback(() => {
      if (canSave) {
        void annotations.save()
      }
    }, [annotations, canSave])

    // Only the session can answer this, so the workspace's save-all is told
    // rather than left to guess from the file name and the dirty flag.
    useEffect(() => {
      onSavableChange(openedDocument.id, canSave)
    }, [canSave, onSavableChange, openedDocument.id])

    // Opened for a drag made of pages, so the view must be the one with gaps —
    // and for a drag rather than a press, it is not stored as a preference.
    const showThumbnails = useCallback(() => {
      if (preferredViewMode === "thumbnail") {
        return
      }

      viewModeChosen.current = false
      setPreferredViewMode("thumbnail")
    }, [preferredViewMode])

    // The workspace's handoff with this document's own id filled in, so its grid
    // asks whether a drag has left for somewhere the workspace answers for.
    const handoff = useMemo<PageHandoff>(
      () => ({
        cancel: pageHandoff.cancel,
        claim: (point) => pageHandoff.claim(openedDocument.id, point),
        drop: (point, pages) => pageHandoff.drop(openedDocument.id, point, pages),
      }),
      [openedDocument.id, pageHandoff],
    )

    // Armed when the paste handler lands, so a keypress ahead of the render
    // still pastes what the clipboard holds.
    pastePagesRef.current = pastePages

    useImperativeHandle(
      ref,
      () => ({
        dismissNoteFont: clearNoteFontOffer,
        fetchNoteFont: () => void fetchNoteFont(),
        hasUnsavedWorkNow,
        onFileDrag: gridDrop.handleFileDrag,
        onPageDrag: gridDrop.handlePageDrag,
        openPageNumbers: openPageNumbersDialog,
        openSearch: search.openSearch,
        openWatermark: openWatermarkDialog,
        print: () => void startPrint(),
        rememberViewNow,
        save: saveDocument,
        saveAs: () => void exportPdf(),
        selectAll,
        showThumbnails,
        snapshotForMove,
        undo: () => {
          if (annotations.canUndo) {
            undoStep()
          }
        },
      }),
      [
        annotations.canUndo,
        clearNoteFontOffer,
        exportPdf,
        fetchNoteFont,
        gridDrop.handleFileDrag,
        gridDrop.handlePageDrag,
        hasUnsavedWorkNow,
        openPageNumbersDialog,
        openWatermarkDialog,
        rememberViewNow,
        saveDocument,
        search.openSearch,
        selectAll,
        showThumbnails,
        snapshotForMove,
        startPrint,
        undoStep,
      ],
    )

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

    // The offer is a condition rather than an event, so it is put back whenever
    // its button changes: raising a standing notice again only updates it.
    useEffect(() => {
      if (noteFontOffer) {
        notice.raise(noteFontOffer, {
          action: { busy: fetchingNoteFont, kind: "noteFont" },
        })
      } else {
        notice.retract(["noteFontMissing"])
      }
    }, [fetchingNoteFont, notice, noteFontOffer])

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
        <SessionHeader
          active={active}
          annotations={annotations}
          bookmarksApply={bookmarksApply}
          bookmarksLabel={bookmarksLabel}
          bookmarksOpen={bookmarksOpen}
          bookApplies={bookApplies}
          canSave={canSave}
          document={pdfDocument}
          drawingApplies={drawingApplies}
          macOS={macOS}
          menu={menu}
          onBookmarksOpenChange={setBookmarksOpen}
          onChangeViewMode={changeViewMode}
          onRotate={() => {
            if (viewMode === "thumbnail") {
              rotateThumbnailPages()
            } else {
              setPageRotations(rotationsAfterRotate)
            }
          }}
          onRedo={() => {
            // Only a page-moving step would strand the uncommitted note on a
            // shifted page; the target is the head of the queue's live history.
            const target = annotations.historyNow().future.at(-1)?.command
            if (target && movesPages(target)) {
              cancelTextNote()
            }
            void annotations.redo()
          }}
          onSave={saveDocument}
          onSaveAs={() => void exportPdf()}
          onExportImages={() => setImageExportOpen(true)}
          onSplit={() => setSplitOpen(true)}
          onCompress={() => setCompressOpen(true)}
          onSearchClose={search.closeSearch}
          onSearchOpen={search.openSearch}
          onToolChange={setActiveTool}
          onUndo={undoStep}
          page={{
            current: currentPage,
            input: pageInput,
            inputFocused: pageInputFocused,
            onFocusedChange: setPageInputFocused,
            onInput: setPageInput,
            onSubmit: submitPageNumber,
          }}
          print={print}
          saveHint={saveHint}
          saveLabel={saveLabel}
          searchOpen={search.searchOpen}
          tool={{
            activeTool,
            highlightColor,
            onHighlightColorChange: changeHighlightColor,
            onPageNumbers: openPageNumbersDialog,
            onRectStyleChange: changeRectStyle,
            onWatermark: openWatermarkDialog,
            rectStyle,
            textNoteColor: textNoteStyle.color,
          }}
          viewMode={viewMode}
          zoom={zoom}
          zoomApplies={zoomApplies}
        />

        {active && imageExportOpen && pdfDocument ? (
          <ImageExportDialog
            document={pdfDocument}
            suggestedName={fileName}
            onExport={annotations.exportArchive}
            onClose={() => setImageExportOpen(false)}
          />
        ) : null}

        {active && splitOpen && pdfDocument ? (
          <SplitPdfDialog
            document={pdfDocument}
            suggestedName={fileName}
            onExport={annotations.exportArchive}
            onClose={() => setSplitOpen(false)}
          />
        ) : null}

        {active && compressOpen && pdfDocument ? (
          <CompressExportDialog
            document={pdfDocument}
            suggestedName={fileName}
            onExport={annotations.exportCompressed}
            onClose={() => setCompressOpen(false)}
          />
        ) : null}

        {active && search.searchOpen ? (
          <div data-document-search={openedDocument.id}>
            <PdfSearch
              activeIndex={search.activeIndex}
              failed={search.failed}
              limitReached={search.limitReached}
              matchCount={search.matches.length}
              onClose={search.closeSearch}
              onNext={() => search.stepMatch(1)}
              onPrevious={() => search.stepMatch(-1)}
              onQueryChange={search.setQuery}
              query={search.query}
              searching={search.searching}
            />
          </div>
        ) : null}

        <div className="flex h-full pt-21">
          {pdfDocument && bookmarksOpen ? (
            <BookmarkSidebar
              items={pdfDocument.outline}
              onNavigate={scrollToPage}
            />
          ) : null}

          {/* The viewer's scroll box cannot host the readout: anything absolute
              inside it is placed against scrolled content and would drift. */}
          <div className="relative min-w-0 flex-1">
            <main
              className="relative size-full overflow-auto bg-zinc-200/70 dark:bg-zinc-950"
              data-tool-cursor={toolCursor}
              ref={viewerRef}
            >
              <PdfViewerLayout
                currentPage={currentPage}
                documentId={pdfDocument.id}
                drafts={rectTool.drafts}
                notes={textNote.previews}
                onPagePaint={onPagePaint}
                fileName={fileName}
                key={pdfDocument.id}
                pageEdit={{
                  canPaste: pageClipboard.clipboard !== null,
                  cutPages: cutThumbnailPages,
                  dropIndex: gridDrop.dropIndex,
                  handoff,
                  onClearSelection: clearThumbnailSelection,
                  onCopyPages: pageClipboard.copy,
                  onCutPages: pageClipboard.cut,
                  onDeletePage: deleteThumbnailPage,
                  onInsertBlankPage: insertBlankPage,
                  onMenuPage: menuThumbnailPage,
                  onOpenPage: openThumbnailPage,
                  onPastePages: pastePages,
                  onReorderPages: reorderPages,
                  onRotatePages: rotateThumbnailPages,
                  onSelectPage: selectThumbnailPage,
                  selectedPages: thumbnailSelection.selectedPages,
                  thumbnailKeys: thumbnailIdentity.keys,
                }}
                pages={pdfDocument.pages}
                referencePageWidth={zoom.referencePageWidth}
                renderEpochs={annotations.renderEpochs}
                rotations={pageRotations}
                scale={zoom.scale}
                searchMatchesByPage={search.matchesByPage}
                activeSearchIndex={search.activeIndex}
                onCopyAllText={copyDocumentText}
                textEpochs={annotations.textEpochs}
                textSelectAll={textSelectAll.selectedAll}
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

        {/* Outside the viewer's scroll box, in the screen space it positions
            itself against — inside, it would scroll away with the page it is on. */}
        {textNote.draft && pdfDocument?.pages[textNote.draft.pageNumber - 1] ? (
          <TextNoteEditor
            draft={textNote.draft}
            editorRef={textNote.editorRef}
            onCancel={textNote.cancel}
            onCommit={textNote.commit}
            onStyleChange={changeTextNoteStyle}
            onTextChange={textNote.setText}
            page={pdfDocument.pages[textNote.draft.pageNumber - 1]!}
            rotation={rotationForPage(pageRotations, textNote.draft.pageNumber)}
            style={textNoteStyle}
            viewerRef={viewerRef}
          />
        ) : null}

        <SessionDialogs
          active={active}
          pageCount={pdfDocument?.numPages ?? 0}
          pageNumbers={pageNumbers}
          print={print}
          watermark={watermark}
        />
      </div>
    )
  },
)
