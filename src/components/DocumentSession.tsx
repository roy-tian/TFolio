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
import { Bookmark, Printer, RotateCw, Save, Search } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import { BookmarkSidebar } from "@/components/BookmarkSidebar"
import { HistoryControls } from "@/components/HistoryControls"
import { PageNumbersDialog } from "@/components/PageNumbersDialog"
import { PageOdometer } from "@/components/PageOdometer"
import { PdfSearch } from "@/components/PdfSearch"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { PrintDialog } from "@/components/PrintDialog"
import { PrintSheet } from "@/components/PrintSheet"
import { TextNoteEditor } from "@/components/TextNoteEditor"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { WatermarkDialog } from "@/components/WatermarkDialog"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { WindowControls } from "@/components/WindowControls"
import { ZoomControls } from "@/components/ZoomControls"
import { ZoomIndicator } from "@/components/ZoomIndicator"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Toggle } from "@/components/ui/toggle"
import { useAnnotations } from "@/hooks/useAnnotations"
import { useCurrentPageTracker } from "@/hooks/useCurrentPageTracker"
import { useDocumentNotices, type NoticeChannel } from "@/hooks/useNotices"
import { usePageClipboard } from "@/hooks/usePageClipboard"
import { usePrint } from "@/hooks/usePrint"
import { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import type { PageHandoffTarget } from "@/hooks/usePageHandoff"
import { useEraserTool } from "@/hooks/useEraserTool"
import { useHighlightTool } from "@/hooks/useHighlightTool"
import { useRectTool } from "@/hooks/useRectTool"
import { usePageNumbers } from "@/hooks/usePageNumbers"
import { useTextNoteTool } from "@/hooks/useTextNoteTool"
import { useTextSelectAll } from "@/hooks/useTextSelectAll"
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
import { dropHitAt, insertIndexForHit } from "@/lib/fileDrop"
import { documentRefusals } from "@/lib/notices"
import {
  formatPageRanges,
  pastePlan,
  type PageClipboard,
} from "@/lib/pageClipboard"
import type { PageHandoff } from "@/lib/pageDrag"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import {
  isPdfPath,
  type PdfDocumentInfo,
  type PdfExportOutcome,
  type PdfSearchMatch,
  type PdfSearchOutcome,
  type PdfStructureUpdate,
} from "@/lib/pdf"
import {
  firstSearchMatchFromPage,
  searchRevealOffset,
  stepSearchMatch,
} from "@/lib/pdfSearch"
import {
  pagesToRotate,
  QUARTER_TURN,
  rotationForPage,
  rotationsAfterRotate,
  rotationsForPageCount,
} from "@/lib/pageRotation"
import { isMacOS } from "@/lib/platform"
import type { PdfOwnedLayerProgressHandler } from "@/lib/progress"
import {
  storeRecentPdfView,
  type RecentPdfView,
} from "@/lib/recentFiles"
import { shortcuts } from "@/lib/shortcuts"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
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
import { cn } from "@/lib/utils"
import {
  anchorCorrection,
  anchorOnPage,
  type ViewportAnchor,
} from "@/lib/viewportAnchor"
import type { WatermarkConfig } from "@/lib/watermark"
import { CONTENT_PADDING_X, CONTENT_PADDING_Y } from "@/lib/zoom"

const RECENT_VIEW_WRITE_INTERVAL_MS = 250
const RESIZE_COMPOSITOR_SETTLE_MS = 150

const SEARCH_REVEAL_TIMEOUT_MS = 3000

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
  const [hasMergedPages, setHasMergedPages] = useState(false)
  // Only the insertion line reads this; every drop resolves the point again,
  // so a stale index can never place anything.
  const [dropIndex, setDropIndex] = useState<number | null>(null)
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
  const [pageRotations, setPageRotations] = useState(() =>
    openedDocument.pages.map(() => 0),
  )
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchMatches, setSearchMatches] = useState<PdfSearchMatch[]>([])
  const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [searchLimitReached, setSearchLimitReached] = useState(false)
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
  const [viewerWidth, setViewerWidth] = useState(0)
  const [viewerHeight, setViewerHeight] = useState(0)
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
  const pendingScrollPageRef = useRef<number | null>(null)
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
  const pendingRecentViewRef = useRef<{
    path: string
    version: number
    view: RecentPdfView
  } | null>(null)
  const writtenRecentViewVersionRef = useRef(0)
  const recentViewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const recentViewWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  // Where the reader was when the viewport last changed size, taken before the
  // layout that change resolves to, and paid back once it has been made.
  const resizeAnchorRef = useRef<ViewportAnchor | null>(null)
  // The tracked page, for the resize observer below: it is bound once, so it
  // cannot read a value that re-renders.
  const currentPageRef = useRef(currentPage)
  // The last geometry the viewer really had, which a hidden tab keeps.
  const committedSizeRef = useRef({ height: 0, width: 0 })
  const mountedRef = useRef(false)
  const searchGenerationRef = useRef(0)
  const searchCancellationRef = useRef<Promise<void>>(Promise.resolve())
  const notice = useDocumentNotices(notices, openedDocument.id)
  // Which offer a fetch in flight belongs to. A download cannot be called back,
  // so what it returns to is checked against this instead.
  const noteFontOfferRef = useRef(0)
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
  // The mode the last commit actually laid out, so a switch can be told from a
  // re-render — the layout is what strands an offset, not the stored choice.
  const laidOutViewModeRef = useRef(viewMode)

  // The grid has no single scale for a zoom to act on. The controls are absent
  // rather than disabled: disabled is what an unopened document means.
  const zoomApplies = viewMode === "single" || viewMode === "book"
  const bookmarksApply = viewMode === "thumbnail"
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

  const focusSearchInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-document-search="${openedDocument.id}"] input`,
      )

      input?.focus()
      input?.select()
    })
  }, [openedDocument.id])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    focusSearchInput()
  }, [focusSearchInput])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-document-session="${openedDocument.id}"] [data-slot="pdf-search-trigger"]`,
        )
        ?.focus()
    })
  }, [openedDocument.id])

  // PDFium's page text, not the DOM's: it reaches virtualized pages whose text
  // layer is not mounted. Debounced, so IME compositions do not launch passes.
  useEffect(() => {
    const generation = searchGenerationRef.current + 1
    searchGenerationRef.current = generation
    let running = false

    setSearchFailed(false)
    setSearchLimitReached(false)
    setSearchMatches([])
    setActiveSearchIndex(null)

    const query = searchQuery.trim()

    if (!active || !searchOpen || query.length === 0) {
      setSearching(false)

      return
    }

    setSearching(true)
    const timer = setTimeout(() => {
      void (async () => {
        // A new term waits for the old run's cancellation command first: the
        // search itself releases the PDFium lock at the next page boundary.
        await searchCancellationRef.current

        if (searchGenerationRef.current !== generation) {
          return
        }

        running = true

        try {
          const outcome = await invoke<PdfSearchOutcome>("search_pdf_text", {
            documentId: pdfDocument.id,
            query,
          })

          if (
            searchGenerationRef.current !== generation ||
            outcome.cancelled
          ) {
            return
          }

          setSearchLimitReached(outcome.limitReached)
          setSearchMatches(outcome.matches)
          setActiveSearchIndex(
            firstSearchMatchFromPage(outcome.matches, currentPageRef.current),
          )
        } catch {
          if (searchGenerationRef.current === generation) {
            setSearchFailed(true)
          }
        } finally {
          running = false

          if (searchGenerationRef.current === generation) {
            setSearching(false)
          }
        }
      })()
    }, 180)

    return () => {
      clearTimeout(timer)

      if (searchGenerationRef.current === generation) {
        searchGenerationRef.current += 1
      }

      if (running) {
        searchCancellationRef.current = invoke<boolean>("cancel_pdf_search", {
          documentId: pdfDocument.id,
        }).then(
          () => undefined,
          () => undefined,
        )
      }
    }
  }, [
    active,
    annotations.textEpochs,
    pdfDocument.id,
    pdfDocument.pages,
    searchOpen,
    searchQuery,
  ])

  const searchMatchesByPage = useMemo(() => {
    const byPage = new Map<
      number,
      Array<{ index: number; match: PdfSearchMatch }>
    >()

    searchMatches.forEach((match, index) => {
      const pageMatches = byPage.get(match.pageNumber) ?? []
      pageMatches.push({ index, match })
      byPage.set(match.pageNumber, pageMatches)
    })

    return byPage
  }, [searchMatches])

  const stepSearch = useCallback(
    (direction: -1 | 1) => {
      setActiveSearchIndex((current) =>
        stepSearchMatch(current, searchMatches.length, direction),
      )
    },
    [searchMatches.length],
  )

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
      saveAsDefaultName ?? t("annotate.exportDefaultName"),
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

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    // Taken while the old layout stands: fitting pages to a new width slides
    // the page away. The reading line is the viewer's own top edge.
    const captureResizeAnchor = () => {
      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${currentPageRef.current}"]`,
      )
      const rect = viewer.getBoundingClientRect()
      const pageRect = page?.getBoundingClientRect()

      // Only a page on screen can hold the reader's place: mid-seek the tracked
      // page is pages off, and anchoring to it lands nowhere the reader was.
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

    // A hidden tab has no layout box and the observer reports 0x0; committing
    // that loses the reader's place. Hold the last real geometry instead.
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

      // Skip the first size, which has no reading position behind it, and any
      // pending seek — a returning tab finds its page its own way.
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
    let compositorTimer: ReturnType<typeof setTimeout> | undefined

    // Layout tracks the window in real time; only the PDFium renders are
    // debounced. Measured off the element, the box the activation check reads.
    const resizeObserver = new ResizeObserver(() => {
      if (!viewer.dataset.resizeCompositing) {
        viewer.dataset.resizeCompositing = "true"
      }
      clearTimeout(compositorTimer)
      compositorTimer = setTimeout(() => {
        delete viewer.dataset.resizeCompositing
      }, RESIZE_COMPOSITOR_SETTLE_MS)
      commitSize(viewer.clientWidth, viewer.clientHeight)
    })
    resizeObserver.observe(viewer)

    return () => {
      resizeObserver.disconnect()
      clearTimeout(compositorTimer)
      delete viewer.dataset.resizeCompositing
    }
  }, [])

  // A layout effect, so the correction lands in the same frame as the new size
  // and the reader sees the column change width, not the document jump.
  useLayoutEffect(() => {
    const anchor = resizeAnchorRef.current
    const viewer = viewerRef.current

    // A queued seek owns the offset instead: it names a page in the layout just
    // made, while the anchor describes one that was never committed.
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

  // A tab hidden through a resize holds an offset into a stale layout; seek the
  // page once the new size is committed, as a layout effect or never at all.
  useLayoutEffect(() => {
    const viewer = viewerRef.current

    if (!active || !viewer || restoringRecentView) {
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
  }, [active, currentPage, restoringRecentView])

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

  useEffect(() => {
    if (!active || !searchOpen || activeSearchIndex === null) {
      return
    }

    const match = searchMatches[activeSearchIndex]
    const viewer = viewerRef.current

    if (!match || !viewer) {
      return
    }

    currentPageRef.current = match.pageNumber
    setCurrentPage(match.pageNumber)

    // A thumbnail has nowhere to draw a result: return to the page view, whose
    // pending seek brings the page up before the rectangle-level seek below.
    if (viewMode === "thumbnail") {
      pendingScrollPageRef.current = match.pageNumber
      setBookmarksOpen(false)
      setPreferredViewMode("single")

      return
    }

    const interruptScroll = () => viewer.scrollTo({
      behavior: "instant",
      left: viewer.scrollLeft,
      top: viewer.scrollTop,
    })
    interruptScroll()

    const activeMatchRects = () =>
      Array.from(
        viewer.querySelectorAll<HTMLElement>(
          `[data-search-match="${activeSearchIndex}"]`,
        ),
        (rectangle) => rectangle.getBoundingClientRect(),
      )

    const page = viewer.querySelector<HTMLElement>(
      `[data-page-number="${match.pageNumber}"]`,
    )
    const pageBox = page?.getBoundingClientRect()
    const viewerBox = viewer.getBoundingClientRect()

    // A page off screen, sideways included, is virtualized with no highlight to
    // measure: bring it over first so the near-viewport observer attaches one.
    if (
      activeMatchRects().length === 0 &&
      (!pageBox ||
        pageBox.bottom <= viewerBox.top ||
        pageBox.top >= viewerBox.bottom ||
        pageBox.right <= viewerBox.left ||
        pageBox.left >= viewerBox.right)
    ) {
      page?.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "center",
      })
    }

    let frame = 0
    const deadline = performance.now() + SEARCH_REVEAL_TIMEOUT_MS
    const revealMatch = () => {
      const rects = activeMatchRects()

      if (rects.length > 0) {
        const offset = searchRevealOffset(
          rects,
          viewer.getBoundingClientRect(),
          document
            .querySelector<HTMLElement>(
              `[data-document-search="${openedDocument.id}"] [data-slot="pdf-search"]`,
            )
            ?.getBoundingClientRect() ?? null,
          {
            minLeft: -viewer.scrollLeft,
            maxLeft: viewer.scrollWidth - viewer.clientWidth - viewer.scrollLeft,
            minTop: -viewer.scrollTop,
            maxTop: viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop,
          },
        )

        if (offset) {
          viewer.scrollTo({
            behavior: "smooth",
            left: viewer.scrollLeft + offset.left,
            top: viewer.scrollTop + offset.top,
          })
        }

        return
      }

      // The layer is drawn once PDFium has the page back, which the seek above
      // only starts; a heavy page can take a good part of a second.
      if (performance.now() < deadline) {
        frame = requestAnimationFrame(revealMatch)
      }
    }

    frame = requestAnimationFrame(revealMatch)

    return () => {
      cancelAnimationFrame(frame)
      interruptScroll()
    }
  }, [
    active,
    activeSearchIndex,
    openedDocument.id,
    searchMatches,
    searchOpen,
    viewMode,
  ])

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

  // A right-click on a page the selection does not hold takes the selection to
  // it, as every file manager does: the menu then acts on what is on screen.
  const menuThumbnailPage = (pageNumber: number) => {
    if (!thumbnailSelection.selectedPages.has(pageNumber)) {
      thumbnailSelection.select(pageNumber, { range: false, toggle: false })
    }
  }

  // Gestures name pages read off the screen, so they are dropped while a
  // page-shifting edit is in flight; an annotation in flight shifts nothing.
  const editingBusy = () => annotations.isStructureBusyNow()

  // On a selected page the x takes the whole selection with it; on any other
  // page, that page alone. No confirmation: the delete is one undo away.
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

  /**
   * The rotate button over the grid, where turning a page edits the document —
   * undone and saved like any other — taking the selection, or all of it.
   */
  const rotateThumbnailPages = () => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.rotatePages(
      pagesToRotate(pdfDocument.numPages, thumbnailSelection.selectedPages),
      QUARTER_TURN,
    )
  }

  /**
   * A cut is a move, one undo step by way of the reorder command; a copy stays
   * on the clipboard, following the pages its own insert pushed down.
   */
  const pastePages = (index: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    const plan = pastePlan(pageClipboard.clipboard, index, pdfDocument.numPages)

    if (!plan) {
      return
    }

    const count = plan.pages.length
    const at = index <= pdfDocument.numPages ? index : undefined

    // Said once the edit has landed rather than when it was asked for: a
    // refusal has its own notice, and two would be one too many.
    if (plan.kind === "move") {
      void annotations.reorderPages(plan.order).then((landed) => {
        if (landed) {
          notice.raise(
            at === undefined ? "pagesMovedToEnd" : "pagesMoved",
            { values: at === undefined ? { count } : { at, count } },
          )
        }
      })

      return
    }

    // Armed before the work, because the insert's own structure change is what
    // reaches the clipboard first — and disarmed if that insert never lands.
    pageClipboard.armPaste(index, count, pdfDocument.numPages)
    void annotations
      .duplicatePages(plan.pages, index, pdfDocument.numPages)
      .then((landed) => {
        if (landed) {
          notice.raise(
            at === undefined ? "pagesPastedToEnd" : "pagesPasted",
            { values: at === undefined ? { count } : { at, count } },
          )
        } else {
          pageClipboard.disarmPaste()
        }
      })
  }

  pastePagesRef.current = pastePages

  // Answered with, rather than voided: the grid holds the pages where the drop
  // put them until this settles, since nothing moves before the backend has.
  const reorderPages = (order: number[]) => {
    if (editingBusy()) {
      return
    }

    return annotations.reorderPages(order)
  }

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

  // Each PDF in drop order, advancing by what the backend says the insert
  // added — the document's own growth could count an edit landing in between.
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

  // A desktop PDF, from the window's one drag handler (see `App.tsx`). Only the
  // grid takes one — it is the one surface where a position can be pointed at.
  const handleFileDrag = useCallback(
    (event: FileDragEvent): boolean => {
      const viewer = viewerRef.current

      if (
        event.kind === "leave" ||
        !active ||
        !viewer ||
        viewMode !== "thumbnail"
      ) {
        setDropIndex(null)
        return false
      }

      // An untakeable drag goes to the workspace, whose target honestly says
      // the file opens; null paths mean the window never heard them, not none.
      if (!(event.paths?.some(isPdfPath) ?? true)) {
        setDropIndex(null)
        return false
      }

      // Resolved from the point every time, drop included: the drawn index
      // belongs to its render, and a file lands where the pointer is now.
      const index = insertIndexForHit(
        dropHitAt(event.point, viewer),
        event.point.x,
      )

      setDropIndex(event.kind === "over" ? index : null)

      if (index === null) {
        return false
      }

      if (event.kind === "over") {
        return true
      }

      // Claimed either way: a drop it cannot act on is an error shown here, not
      // a tab opened behind the reader's back; the busy case is the one such.
      if (annotations.isStructureBusyNow()) {
        notice.raise("editInFlight")
      } else {
        void insertFiles(event.paths.filter(isPdfPath), index)
      }

      return true
    },
    [active, annotations, insertFiles, notice, viewMode],
  )

  /**
   * Pages from another document's grid, brought here once the workspace sprung
   * this tab open — landing as a dropped file would, as copies the source keeps.
   */
  const handlePageDrag = useCallback(
    (event: PageDragEvent): boolean => {
      const viewer = viewerRef.current

      if (
        event.kind === "leave" ||
        !active ||
        !viewer ||
        viewMode !== "thumbnail"
      ) {
        setDropIndex(null)
        return false
      }

      const index = insertIndexForHit(
        dropHitAt(event.point, viewer),
        event.point.x,
      )

      setDropIndex(event.kind === "over" ? index : null)

      if (index === null) {
        return false
      }

      if (event.kind === "over") {
        return true
      }

      // Claimed either way, as a file drop over this grid is: the one case it
      // cannot act on is an edit already renumbering the gap it was read off.
      if (annotations.isStructureBusyNow()) {
        notice.raise("editInFlight")
      } else {
        void annotations.insertPages(
          event.sourceDocumentId,
          event.pages,
          index,
          // Off the ref, as an inserted file's bound is: a structure change
          // writes it before the render that would refresh a captured value.
          documentRef.current?.numPages ?? 0,
        )
      }

      return true
    },
    [active, annotations, notice, viewMode],
  )

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

  // A drag finished elsewhere — a tab switch, the wizard taking the drop —
  // never sends a `leave`, so the line it drew would outlive the drag.
  useEffect(() => {
    if (!active) {
      setDropIndex(null)
    }
  }, [active])

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

  // For the switch nobody pressed: a merge past a one-page document's spread
  // brings book view back. A seek already queued is the more specific target.
  useEffect(() => {
    if (laidOutViewModeRef.current === viewMode) {
      return
    }

    laidOutViewModeRef.current = viewMode

    if (pendingScrollPageRef.current === null) {
      pendingScrollPageRef.current = currentPage
    }
  }, [currentPage, viewMode])

  // The target exists only once the new layout has mounted, so the scroll waits
  // for the commit — or, for a tab returning to a resized window, the geometry.
  useEffect(() => {
    const pendingPage = pendingScrollPageRef.current
    const viewer = viewerRef.current

    if (pendingPage === null || !viewer) {
      return
    }

    // The jump reads as a view swap rather than a scroll, so it lands instantly.
    scrollToPage(pendingPage, "auto")

    const committed = committedSizeRef.current

    // Leaving the grid closes the bookmark sidebar, widening the viewer after
    // the seek was measured; hold the page until settled, so the last seek stands.
    if (
      viewer.clientWidth === committed.width &&
      viewer.clientHeight === committed.height
    ) {
      pendingScrollPageRef.current = null
    }
  }, [viewerHeight, viewerWidth, viewMode])

  const flushRecentView = useCallback(() => {
    const pending = pendingRecentViewRef.current

    if (!pending || pending.version <= writtenRecentViewVersionRef.current) {
      return recentViewWriteChainRef.current
    }

    writtenRecentViewVersionRef.current = pending.version
    // Tauri calls are asynchronous: without this chain a slower older write
    // could land after a newer one and put the document back too far.
    recentViewWriteChainRef.current = recentViewWriteChainRef.current.then(() =>
      storeRecentPdfView(pending.path, pending.view),
    )

    return recentViewWriteChainRef.current
  }, [])

  const queueRecentView = useCallback(
    (view: RecentPdfView) => {
      if (!recentPath) {
        return
      }

      const version = (pendingRecentViewRef.current?.version ?? 0) + 1
      pendingRecentViewRef.current = { path: recentPath, version, view }

      // Leading and trailing samples, one trailing timer: a long scroll is
      // durable as it goes, its resting point written a quarter second later.
      if (recentViewTimerRef.current !== undefined) {
        return
      }

      flushRecentView()
      recentViewTimerRef.current = setTimeout(() => {
        recentViewTimerRef.current = undefined
        flushRecentView()
      }, RECENT_VIEW_WRITE_INTERVAL_MS)
    },
    [flushRecentView, recentPath],
  )

  const rememberCurrentView = useCallback(() => {
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
      return
    }

    const committed = committedSizeRef.current

    if (
      viewer.clientWidth !== committed.width ||
      viewer.clientHeight !== committed.height
    ) {
      return
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
      return
    }

    queueRecentView({
      position: {
        fractionX: anchor.fractionX,
        fractionY: anchor.fractionY,
        pageNumber: anchor.pageNumber,
      },
      viewMode: preferredViewMode,
      zoom: { ...zoom.zoomState },
    })
  }, [
    active,
    currentPage,
    pdfDocument.pages,
    preferredViewMode,
    queueRecentView,
    restoringRecentView,
    pageRotations,
    recentPath,
    viewMode,
    viewerHeight,
    viewerWidth,
    zoom.zoomPreviewing,
    zoom.zoomState,
  ])

  const rememberViewNow = useCallback(() => {
    rememberCurrentView()
    flushRecentView()

    return recentViewWriteChainRef.current
  }, [flushRecentView, rememberCurrentView])

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

  useImperativeHandle(
    ref,
    () => ({
      dismissNoteFont: clearNoteFontOffer,
      fetchNoteFont: () => void fetchNoteFont(),
      hasUnsavedWorkNow,
      onFileDrag: handleFileDrag,
      onPageDrag: handlePageDrag,
      openPageNumbers: openPageNumbersDialog,
      openSearch,
      openWatermark: openWatermarkDialog,
      print: () => void startPrint(),
      rememberViewNow,
      save: saveDocument,
      saveAs: () => void exportPdf(),
      selectAll,
      showThumbnails,
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
      handleFileDrag,
      handlePageDrag,
      hasUnsavedWorkNow,
      openPageNumbersDialog,
      openSearch,
      openWatermarkDialog,
      rememberViewNow,
      saveDocument,
      selectAll,
      showThumbnails,
      startPrint,
      undoStep,
    ],
  )

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

  useEffect(() => {
    window.addEventListener("pagehide", flushRecentView)

    return () => {
      window.removeEventListener("pagehide", flushRecentView)
      clearTimeout(recentViewTimerRef.current)
      recentViewTimerRef.current = undefined
      flushRecentView()
    }
  }, [flushRecentView])

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
      {/* pb-px keeps the content box even: a 47px row centres a 32px control
          on a half pixel, which the WebView rounds per element, fringing it. */}
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
          {active ? (
            <AppMenu
              {...menu}
              canSave={canSave}
              onSave={saveDocument}
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
          <ButtonGroup>
            {/* The chord is named only when it works: a disabled save
                spends the tooltip on why it cannot. */}
            <ToolbarTooltip
              label={saveLabel}
              shortcut={canSave ? shortcuts.save : undefined}
            >
              <Button
                aria-label={t("annotate.save")}
                // A disabled control takes no pointer, and the hint saying why
                // saving is unavailable has to have a hover to open on.
                className="disabled:pointer-events-auto"
                data-slot="pdf-save-trigger"
                disabled={!canSave}
                onClick={saveDocument}
                size="icon"
                variant="outline"
              >
                <Save />
              </Button>
            </ToolbarTooltip>
            <ToolbarTooltip label={t("print.open")} shortcut={shortcuts.print}>
              <Button
                aria-label={t("print.open")}
                data-slot="pdf-print-trigger"
                disabled={!pdfDocument || print.preparing}
                onClick={() => void print.start()}
                size="icon"
                variant="outline"
              >
                <Printer />
              </Button>
            </ToolbarTooltip>
            <ToolbarTooltip label={t("search.open")} shortcut={shortcuts.search}>
              <Toggle
                aria-label={t("search.open")}
                className="size-8"
                data-slot="pdf-search-trigger"
                disabled={!pdfDocument}
                onPressedChange={(pressed) => {
                  if (pressed) {
                    openSearch()
                  } else {
                    closeSearch()
                  }
                }}
                pressed={searchOpen}
                variant="outline"
              >
                <Search />
              </Toggle>
            </ToolbarTooltip>
          </ButtonGroup>
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
              onClick={() => {
                if (viewMode === "thumbnail") {
                  rotateThumbnailPages()
                } else {
                  setPageRotations(rotationsAfterRotate)
                }
              }}
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
          <div className="relative">
            <input
              aria-label={t("toolbar.pageNumberInput")}
              className={cn(
                "h-7 w-10 rounded-md border bg-background px-1 text-center font-mono text-sm tabular-nums outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground",
                // The field holds the value for typed jumps and screen readers,
                // but the odometer does the drawing, over transparent text.
                !pageInputFocused &&
                  "text-transparent disabled:text-transparent",
              )}
              disabled={!pdfDocument}
              inputMode="numeric"
              onBlur={() => {
                setPageInputFocused(false)
                setPageInput(String(currentPage))
              }}
              onChange={(event) =>
                setPageInput(event.target.value.replaceAll(/[^0-9]/g, ""))
              }
              onFocus={(event) => {
                setPageInputFocused(true)
                event.currentTarget.select()
              }}
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
            {/* Deaf to the pointer, so a click lands in the field it covers;
                forced colours un-hide the field's text, so this stands down. */}
            {pageInputFocused ? null : (
              <PageOdometer
                className={cn(
                  "pointer-events-none absolute inset-0 justify-center forced-colors:hidden",
                  !pdfDocument && "text-muted-foreground",
                )}
                value={currentPage}
              />
            )}
          </div>
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
          <HistoryControls
            canRedo={annotations.canRedo}
            canUndo={annotations.canUndo}
            disabled={!pdfDocument}
            nextRedo={annotations.nextRedo}
            nextUndo={annotations.nextUndo}
            onRedo={() => {
              // Only a page-moving step would strand the uncommitted note on a
              // shifted page; the target is the head of the queue's live history.
              const target = annotations.historyNow().future.at(-1)?.command
              if (target && movesPages(target)) {
                cancelTextNote()
              }
              void annotations.redo()
            }}
            onUndo={undoStep}
          />
          <AnnotationToolbar
            activeTool={activeTool}
            disabled={!pdfDocument}
            eraserApplies={drawingApplies}
            highlightApplies={drawingApplies}
            highlightColor={highlightColor}
            onHighlightColorChange={changeHighlightColor}
            onMergeWizard={menu.onMergeWizard}
            onPageNumbers={openPageNumbersDialog}
            onRectStyleChange={changeRectStyle}
            onToolChange={setActiveTool}
            onWatermark={openWatermarkDialog}
            rectApplies={drawingApplies}
            rectStyle={rectStyle}
            textNoteApplies={drawingApplies}
            textNoteColor={textNoteStyle.color}
          />
          {active && !macOS ? <WindowControls /> : null}
        </div>
      </header>

      {active && searchOpen ? (
        <div data-document-search={openedDocument.id}>
          <PdfSearch
            activeIndex={activeSearchIndex}
            failed={searchFailed}
            limitReached={searchLimitReached}
            matchCount={searchMatches.length}
            onClose={closeSearch}
            onNext={() => stepSearch(1)}
            onPrevious={() => stepSearch(-1)}
            onQueryChange={setSearchQuery}
            query={searchQuery}
            searching={searching}
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
                dropIndex,
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
              searchMatchesByPage={searchMatchesByPage}
              activeSearchIndex={activeSearchIndex}
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

      <PrintDialog
        onStop={discardPrint}
        open={active && print.preparing}
        progress={print.progress}
      />

      {active && print.sheet ? <PrintSheet pages={print.sheet} /> : null}
    </div>
  )
})
