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

import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import { AppSidebar, SidebarPanelSwitch } from "@/components/AppSidebar"
import { BookmarkList } from "@/components/BookmarkList"
import { CompressExportDialog } from "@/components/CompressExportDialog"
import { ImageExportDialog } from "@/components/ImageExportDialog"
import { SplitPdfDialog } from "@/components/SplitPdfDialog"
import { PdfSearch } from "@/components/PdfSearch"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { SessionDialogs } from "@/components/SessionDialogs"
import { SessionHeader } from "@/components/SessionHeader"
import { SidebarThumbnails } from "@/components/SidebarThumbnails"
import { TextNoteEditor } from "@/components/TextNoteEditor"
import { ZoomIndicator } from "@/components/ZoomIndicator"
import type { AnnotationTool } from "@/components/AnnotationToolbar"
import { useAnnotations } from "@/hooks/useAnnotations"
import { createCurrentPage } from "@/hooks/useCurrentPage"
import { useCurrentPageTracker } from "@/hooks/useCurrentPageTracker"
import { useDocumentNotices, type NoticeChannel } from "@/hooks/useNotices"
import { usePageClipboard } from "@/hooks/usePageClipboard"
import { usePrint } from "@/hooks/usePrint"
import { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import { useDocumentSearch } from "@/hooks/useDocumentSearch"
import { useEraserTool } from "@/hooks/useEraserTool"
import { useHighlightTool } from "@/hooks/useHighlightTool"
import { useSelectionPageText } from "@/hooks/useSelectionPageText"
import { useTextDragSelection } from "@/hooks/useTextDragSelection"
import { usePageNumbers } from "@/hooks/usePageNumbers"
import { useRecentView } from "@/hooks/useRecentView"
import { useRectTool } from "@/hooks/useRectTool"
import { useSidebar } from "@/hooks/useSidebar"
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
  type RenderEpochs,
  type RectStyle,
  type TextNoteStyle,
} from "@/lib/annotations"
import { copyPlainText } from "@/lib/clipboard"
import { hasLayerOverWorkspace } from "@/lib/contextMenu"
import { panelElementId, tabElementId } from "@/lib/documentTabs"
import { documentPlainText } from "@/lib/documentText"
import { forgetDocumentText } from "@/lib/pageText"
import { transientDocumentRefusals } from "@/lib/notices"
import {
  formatPageRanges,
  type PageClipboard,
} from "@/lib/pageClipboard"
import {
  exportFailureNotice,
  fileNameFromPath,
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
import type { PdfOwnedLayer, PdfProgress } from "@/lib/progress"
import { type RecentPdfView } from "@/lib/recentFiles"
import { shownSidebarPanel } from "@/lib/sidebar"
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
import { viewerReadingBounds, viewerSizeCommitted } from "@/lib/viewerViewport"
import { anchorCorrection, anchorOnPage } from "@/lib/viewportAnchor"
import { CONTENT_PADDING_X, CONTENT_PADDING_Y } from "@/lib/zoom"

export type DocumentSessionHandle = {
  /** Lets go of the edit it held: the note's text lives nowhere else by then. */
  dismissNoteFont: () => void
  fetchNoteFont: () => void
  /** Edits and a typed note, which a save would keep; `hasUnsavedWorkNow`
      also counts work still running, which no save can. */
  hasUnsavedChangesNow: () => boolean
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
  /** The save key: Save As where there is no file, a notice where the
      document is export-only. `save` is what Save all runs, silently. */
  saveFromKey: () => void
  /** The close prompt's Save; resolves true when the close may go ahead. */
  saveForClose: () => Promise<boolean>
  /** The Stop on a layer undo or redo's notice. */
  stopLayerWork: () => void
  redo: () => void
  selectAll: () => void
  undo: () => void
}

type DocumentSessionProps = {
  active: boolean
  document: PdfDocumentInfo
  fileName: string
  /** Whether this app-created document has yet to be written to its first
      file. It remains unsaved even before the reader makes another edit. */
  initialSaveRequired?: boolean
  /** A path-backed document's last reading view. */
  initialRecentView?: RecentPdfView
  /** Overrides the stored preference: a tab moved from another window keeps
      the view it was being read in. */
  initialViewMode?: ViewMode
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
      initialRecentView,
      initialSaveRequired = false,
      initialViewMode,
      menu,
      notices,
      onDirtyChange,
      onSavableChange,
      onSourceChange,
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
    // A copy of a page carrying a watermark or page numbers leaves the document
    // export-only, like those layers. The backend answers with every structure
    // update, so no replay.
    const [hasMergedPages, setHasMergedPages] = useState(
      () => movedSeed?.hasMergedPages ?? false,
    )
    // Read by a close's save, which runs after the queue and before a render.
    const hasMergedPagesRef = useRef(hasMergedPages)
    const [currentPage] = useState(() =>
      createCurrentPage(
        Math.min(
          Math.max(initialRecentView?.position.pageNumber ?? 1, 1),
          Math.max(openedDocument.numPages, 1),
        ),
      ),
    )
    const [pageRotations, setPageRotations] = useState<number[]>(
      () => movedSeed?.pageRotations ?? openedDocument.pages.map(() => 0),
    )
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
    const recentPageRef = useRef<HTMLElement | null>(null)
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
    // reader went on to make successfully. The font offer is not one: it holds
    // a note that exists nowhere else, and only the reader's answer ends it.
    const clearEditRefusals = useCallback(() => {
      notice.retract(transientDocumentRefusals)
    }, [notice])
    // Every rebuild tick raises its notice anew; the reader's Stop must stay
    // pressed through them rather than come back as a live button.
    const layerStoppingRef = useRef(false)

    const bookApplies = hasBookSpread(pdfDocument.numPages)
    const viewMode = effectiveViewMode(preferredViewMode, pdfDocument.numPages)

    // An edit replaces the outline wholesale. Deriving what is shown, rather
    // than switching the sidebar, lets the undo that restores bookmarks restore it.
    const bookmarksApply = pdfDocument.outline.length > 0
    const sidebar = useSidebar()
    const sidebarPanel = shownSidebarPanel(sidebar.panel, bookmarksApply)

    const scrollToPage = useCallback(
      (pageNumber: number, behavior: ScrollBehavior = "smooth") => {
        const page = viewerRef.current?.querySelector<HTMLElement>(
          `[data-page-number="${pageNumber}"]`,
        )

        currentPage.set(pageNumber)
        // A spread centres its pages, so the shorter one's top sits below the
        // row's: seeking it would cut off the top of the taller one.
        const target = page?.closest<HTMLElement>("[data-book-spread]") ?? page
        target?.scrollIntoView({ behavior, block: "start" })
      },
      [currentPage],
    )

    const viewport = useViewerViewport({
      active,
      currentPage,
      restoringRecentView,
      scrollToPage,
      viewMode,
      viewerRef,
    })
    const {
      clientBoxRef,
      committedSizeRef,
      pendingScrollPageRef,
      viewerHeight,
      viewerWidth,
    } = viewport

    const zoom = useZoom({
      contentHeight: Math.max(0, viewerHeight - CONTENT_PADDING_Y),
      contentWidth: Math.max(0, viewerWidth - CONTENT_PADDING_X),
      currentPage,
      disabled: !active,
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
    // The sidebar's previews are where pages are chosen while they show;
    // hiding them lets go of what was chosen.
    const thumbnailsShown =
      sidebar.mode !== "hidden" && sidebarPanel === "thumbnails"
    // The clipboard and select-all keys are the pages' only while focus is in
    // that column: elsewhere they are the text's, as they always were.
    const [thumbnailsFocused, setThumbnailsFocused] = useState(false)
    const thumbnailSelection = useThumbnailSelection({
      active: active && thumbnailsShown,
      numPages: pdfDocument.numPages,
    })
    const clearThumbnailSelection = thumbnailSelection.clear
    // The paste's own work needs the history below, which is set up after this;
    // the hook only ever calls it from a keypress, by which time it is here.
    const pastePagesRef = useRef<(index: number) => void>(() => {})
    const pageClipboard = usePageClipboard({
      active: active && thumbnailsShown && thumbnailsFocused,
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
    // Only a cut marks its pages: a copy takes nothing away, so the
    // pages it named go on reading as the pages they are.
    const cutThumbnailPages = useMemo(
      () => new Set(clipboard?.mode === "cut" ? clipboard.pages : []),
      [clipboard],
    )
    // Fetched as the selection is made, not when the copy asks: the clipboard
    // write must land inside its keypress, and a long document's text is slow.
    // One read per text version: a repeated select-all reuses it, and a
    // selection let go stops a read still under way — unless a copy waits on it.
    const plainTextRead = useRef<{
      controller: AbortController
      copying: boolean
      done: boolean
      epochs: RenderEpochs | null
      numPages: number
      text: Promise<string>
    } | null>(null)
    // Written once the annotations below exist; read when a select-all asks.
    const textEpochsRef = useRef<RenderEpochs | null>(null)
    const readDocumentText = useCallback(() => {
      const textEpochs = textEpochsRef.current
      const last = plainTextRead.current

      if (
        last &&
        last.epochs === textEpochs &&
        last.numPages === pdfDocument.numPages &&
        (last.done || !last.controller.signal.aborted)
      ) {
        return last
      }

      // A copy already asked for the older text: it still gets it.
      if (last && !last.copying) {
        last.controller.abort()
      }

      const controller = new AbortController()
      const read = {
        controller,
        copying: false,
        done: false,
        epochs: textEpochs,
        numPages: pdfDocument.numPages,
        text: documentPlainText(
          pdfDocument.id,
          pdfDocument.numPages,
          controller.signal,
        ),
      }

      read.text.then(
        () => {
          read.done = true
        },
        () => undefined,
      )
      plainTextRead.current = read

      return read
    }, [pdfDocument.id, pdfDocument.numPages])
    const copyDocumentText = useCallback(() => {
      const read = readDocumentText()

      read.copying = true
      void read.text.then(copyPlainText).catch(() => undefined)
    }, [readDocumentText])
    // The page views' half of a select-all; the previews' half is the page
    // selection above, and focus decides which of the two answers.
    const textSelectAll = useTextSelectAll({
      active: active && !thumbnailsFocused,
      onCopy: copyDocumentText,
    })
    const selectAllPages = thumbnailSelection.selectAll
    const selectAllText = textSelectAll.selectAll
    // Where the workspace's select-all shortcut lands: the sidebar's previews
    // hold pages, and the page views hold the text laid over them.
    const selectAll = useCallback(() => {
      if (thumbnailsFocused && thumbnailsShown) {
        selectAllPages()
      } else {
        selectAllText()
      }
    }, [selectAllPages, selectAllText, thumbnailsFocused, thumbnailsShown])
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
        (error: unknown) => notice.raise(exportFailureNotice(error)),
        [notice],
      ),
      // Save As moves the document to its destination, the tab's name and the
      // save key with it — for a byte-opened document, the file it never had.
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
          hasMergedPagesRef.current = update.hasMergedPages
          setHasMergedPages(update.hasMergedPages)

          // Turned where it stands, so every position still holds its page — a
          // second press of the rotation must still find the selection it turns.
          if (movement === "inPlace") {
            return
          }

          // A note held for its font names the page it was typed on, which
          // now holds other content: gone is better than landing elsewhere.
          clearNoteFontOffer()

          setThumbnailIdentity(({ keys, nextKey }) =>
            movement
              ? { keys: movement.map((page) => keys[page - 1]!), nextKey }
              : {
                  keys: update.pages.map((_, index) => keys[index] ?? nextKey + index),
                  nextKey: nextKey + update.numPages,
                },
          )
          currentPage.set(
            Math.min(Math.max(currentPage.get(), 1), Math.max(1, update.numPages)),
          )
          clearThumbnailSelection()
          // The page numbers on the clipboard now name other pages — unless this
          // is the paste's own insert, which says how far they slid.
          pageClipboardStructureChanged(update.numPages)
          setPageRotations((rotations) =>
            rotationsForPageCount(rotations, update.numPages),
          )
        },
        [clearNoteFontOffer, clearThumbnailSelection, currentPage, pageClipboardStructureChanged],
      ),
      onEditRefused: useCallback(
        () => notice.raise("markWhileEditing"),
        [notice],
      ),
      onLayerProgress: useCallback(
        (layer: PdfOwnedLayer, progress: PdfProgress | null) => {
          const kind =
            layer === "watermark" ? "watermarkRebuilding" : "pageNumbersRebuilding"

          if (progress) {
            notice.raise(kind, {
              action: { busy: layerStoppingRef.current, kind: "layerStop" },
              progress,
            })
          } else {
            layerStoppingRef.current = false
            notice.retract([kind])
          }
        },
        [notice],
      ),
      onSuccess: clearEditRefusals,
    })

    useLayoutEffect(() => {
      textEpochsRef.current = annotations.textEpochs
    }, [annotations.textEpochs])

    // Re-read when an edit changes the text under a standing select-all, so a
    // copy never hands out the text as it was before the edit.
    useEffect(() => {
      if (textSelectAll.selectedAll) {
        readDocumentText()
        return
      }

      const read = plainTextRead.current

      if (read && !read.done && !read.copying) {
        read.controller.abort()
        plainTextRead.current = null
      }
    }, [annotations.textEpochs, readDocumentText, textSelectAll.selectedAll])

    const search = useDocumentSearch({
      active,
      currentPage,
      documentId: pdfDocument?.id,
      documentPages: pdfDocument.pages,
      sessionId: openedDocument.id,
      textEpochs: annotations.textEpochs,
      viewerRef,
      viewMode,
    })

    const pageOps = useThumbnailPageOps({
      annotations,
      pageClipboard,
      pdfDocument,
      notice,
      thumbnailSelection,
    })
    const {
      deleteThumbnailPage,
      insertBlankPage,
      menuThumbnailPage,
      pastePages,
      reorderPages,
      rotateThumbnailPages,
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
    const print = usePrint({
      documentId: pdfDocument?.id,
      onError: () => notice.raise("printFailed"),
      pages: pdfDocument?.pages ?? [],
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

    const textSelectable =
      active && (activeTool === null || activeTool === "highlight")

    const finishTextDrag = useTextDragSelection({
      enabled: textSelectable,
      pages: pdfDocument.pages,
      rotations: pageRotations,
      viewerRef,
    })

    useSelectionPageText({
      active,
      documentId: pdfDocument.id,
      textEpochs: annotations.textEpochs,
      viewerRef,
    })

    const highlightTool = useHighlightTool({
      active: active && activeTool === "highlight",
      color: highlightColor,
      finishTextDrag,
      onCommit: annotations.commit,
      opacity: HIGHLIGHT_OPACITY,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      selectable: textSelectable,
      viewerRef,
    })

    const drawingRect = activeTool === "rect"
    const rectTool = useRectTool({
      active: active && drawingRect,
      onCommit: annotations.commit,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      style: rectStyle,
      viewerRef,
    })

    const erasing = activeTool === "eraser"
    useEraserTool({
      active: active && erasing,
      onErase: annotations.eraseAt,
      pages: pdfDocument?.pages ?? [],
      rotations: pageRotations,
      viewerRef,
    })

    const drawingTextNote = activeTool === "textNote"
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
    const toolCursor = activeTool

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
    // Changes a save would keep, apart from work still running: a close
    // prompt words the two differently, and only the first has a save.
    const hasUnsavedChangesNow = useCallback(
      () =>
        saveRequiredRef.current ||
        annotations.isDirtyNow() ||
        isNoteWorthKeeping(textNote.draft?.text ?? "") ||
        unfontedEdit !== null,
      [annotations, textNote.draft?.text, unfontedEdit],
    )
    const hasUnsavedWorkNow = useCallback(
      () => hasUnsavedChangesNow() || annotations.hasPendingWorkNow(),
      [annotations, hasUnsavedChangesNow],
    )

    useEffect(() => {
      onDirtyChange(
        openedDocument.id,
        saveRequired || annotations.isDirty || draftDirty || unfontedEdit !== null,
      )
    }, [
      annotations.isDirty,
      draftDirty,
      onDirtyChange,
      openedDocument.id,
      saveRequired,
      unfontedEdit,
    ])

    const changeHighlightColor = useCallback((color: HexColor) => {
      setHighlightColor(color)
      storeHighlightColor(color)
    }, [])

    // A slider's drag changes the style on every step but is stored once, as
    // it is let go: each store rewrites the settings file and wakes every window.
    const changeRectStyle = useCallback((style: RectStyle, transient = false) => {
      setRectStyle(style)

      if (!transient) {
        storeRectStyle(style)
      }
    }, [])

    const changeTextNoteStyle = useCallback(
      (style: TextNoteStyle, transient = false) => {
        setTextNoteStyle(style)

        if (!transient) {
          storeTextNoteStyle(style)
        }
      },
      [],
    )

    // What every export names its file after: a converted or assembled
    // document's own PDF name, else the file the document came from, else the
    // tab's — never a Word or image source's name with its extension still on.
    const exportBaseName =
      saveAsDefaultName ??
      (pdfDocument.path ? fileNameFromPath(pdfDocument.path) : fileName)

    // The destination dialog is the backend's own, so this only says *that* an
    // export happens; `onExportError` reports a failed write.
    const exportPdf = useCallback(() => {
      // A copy-only document may not go over the file it came from, so its
      // own name is the one suggestion bound to be refused.
      const copyOnly =
        Boolean(documentRef.current?.path) &&
        (annotations.hasOwnedContentNow() || hasMergedPagesRef.current)
      const name = copyOnly
        ? `${exportBaseName.replace(/\.pdf$/i, "")}-${t("annotate.copySuffix")}.pdf`
        : exportBaseName

      return annotations.exportCopy(name, t("annotate.exportFilter"))
    }, [annotations, exportBaseName, t])

    useEffect(() => {
      mountedRef.current = true

      return () => {
        mountedRef.current = false

        queueMicrotask(() => {
          if (!mountedRef.current && documentRef.current) {
            // Past a close, every page left would read as empty: a copy of that
            // is worse than none.
            plainTextRead.current?.controller.abort()
            forgetDocumentText(documentRef.current.id)
            closePdf(documentRef.current.id)
            documentRef.current = null
          }
        })
      }
    }, [])

    // Restored against the first real layout, once size and saved zoom have both
    // sized the pages; normalized, so a new window size stays a useful position.
    useLayoutEffect(() => {
      const position = initialRecentPositionRef.current
      const viewer = viewerRef.current

      if (!restoringRecentView || !active || !position || !viewer) {
        return
      }

      if (
        viewerWidth <= 0 ||
        viewerHeight <= 0 ||
        !viewerSizeCommitted(viewer, committedSizeRef.current)
      ) {
        return
      }

      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${position.pageNumber}"]`,
      )
      const viewerRect = viewerReadingBounds(viewer)
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

    const redoStep = useCallback(() => {
      // Only a page-moving step would strand the uncommitted note on a
      // shifted page; the target is the head of the queue's live history.
      const target = annotations.historyNow().future.at(-1)?.command

      if (target && movesPages(target)) {
        cancelTextNote()
      }

      void annotations.redo()
    }, [annotations, cancelTextNote])

    useCurrentPageTracker(
      viewerRef,
      active ? pdfDocument.id : undefined,
      viewMode,
      currentPage.set,
      zoom.zoomPreviewing || restoringRecentView,
      pdfDocument.pages,
    )

    useEffect(() => {
      if (!active) {
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

        const current = currentPage.get()
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

        // Sets the page at once, so a held key's every repeat still turns
        // exactly one page or spread from the last.
        scrollToPage(target, "auto")
      }

      document.addEventListener("keydown", handlePageTurn)

      return () => {
        document.removeEventListener("keydown", handlePageTurn)
      }
    }, [active, currentPage, pdfDocument.numPages, scrollToPage, viewMode])

    // Each mode stacks pages to a different height, so the kept offset would land
    // somewhere unrelated; queued here, ahead of the next render's layout effects.
    const changeViewMode = (mode: ViewMode) => {
      if (mode !== viewMode) {
        pendingScrollPageRef.current = currentPage.get()
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

      if (!viewerSizeCommitted(viewer, committedSizeRef.current)) {
        return null
      }

      // A scroll only moves this node; find it again when tracking switches
      // pages or the layout replaces it.
      const pageNumber = currentPage.get()
      let page = recentPageRef.current

      if (
        !page ||
        page.dataset.pageNumber !== String(pageNumber) ||
        !viewer.contains(page)
      ) {
        page = viewer.querySelector<HTMLElement>(
          `[data-page-number="${pageNumber}"]`,
        )
        recentPageRef.current = page
      }
      const viewerRect = viewerReadingBounds(viewer)
      const pageRect = page?.getBoundingClientRect()
      const anchor = pageRect
        ? anchorOnPage(
            pageNumber,
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

      // Wheel events can outnumber paints. Read page geometry once per frame.
      let frame = 0
      const scheduleRememberCurrentView = () => {
        if (frame) {
          return
        }

        frame = requestAnimationFrame(() => {
          frame = 0
          rememberCurrentView()
        })
      }

      viewer.addEventListener("scroll", scheduleRememberCurrentView, {
        passive: true,
      })
      // The tracker settles the page a frame after the scroll that moved it,
      // possibly after this frame's sample: anchor on the page it settles on.
      const stopFollowingPage = currentPage.subscribe(scheduleRememberCurrentView)
      rememberCurrentView()

      return () => {
        viewer.removeEventListener("scroll", scheduleRememberCurrentView)
        stopFollowingPage()
        cancelAnimationFrame(frame)
      }
    }, [currentPage, rememberCurrentView])

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

    // Owned page content (watermark, numbers) and copies of it leave a document
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

    // The toolbar's and menu's action, refusal included: a watermarked
    // document, or one holding copies of such pages, may only ever be exported
    // as a copy.
    const saveDocument = useCallback(() => {
      if (canSave) {
        void annotations.save()
      }
    }, [annotations, canSave])

    // The save key where the button would be greyed out: a document with no
    // file asks where to put one, as Save As does; an export-only one says why
    // the key did nothing, which a tooltip no key press shows cannot.
    const saveFromKey = useCallback(() => {
      if (canSave) {
        void annotations.save()
      } else if (!hasSourceFile) {
        void exportPdf()
      } else if (hasOwnedContent) {
        notice.raise("saveOwnedContentOnly")
      } else if (hasMergedPages) {
        notice.raise("saveMergedOnly")
      }
    }, [
      annotations,
      canSave,
      exportPdf,
      hasMergedPages,
      hasOwnedContent,
      hasSourceFile,
      notice,
    ])

    // A close prompt's Save: back over the file where the document may be
    // written there, otherwise Save As — a copy, for an export-only one. True
    // when the close may go ahead; a cancelled or failed save keeps the tab.
    const commitTextNote = textNote.commit
    const saveForClose = useCallback(async () => {
      // A note held for its missing font cannot be saved; the offer stands.
      if (unfontedEdit) {
        return false
      }

      // Closing the editor keeps what was typed, as clicking away from it does.
      await commitTextNote()
      await annotations.settled()

      if (!saveRequiredRef.current && !annotations.isDirtyNow()) {
        return true
      }

      const writesBack =
        Boolean(documentRef.current?.path) &&
        !saveRequiredRef.current &&
        !annotations.hasOwnedContentNow() &&
        !hasMergedPagesRef.current

      return writesBack
        ? annotations.save()
        : (await exportPdf()) === "saved"
    }, [annotations, commitTextNote, exportPdf, unfontedEdit])

    // Only the session can answer this, so the workspace's save-all is told
    // rather than left to guess from the file name and the dirty flag.
    useEffect(() => {
      onSavableChange(openedDocument.id, canSave)
    }, [canSave, onSavableChange, openedDocument.id])

    // Armed when the paste handler lands, so a keypress ahead of the render
    // still pastes what the clipboard holds.
    pastePagesRef.current = pastePages

    useImperativeHandle(
      ref,
      () => ({
        dismissNoteFont: clearNoteFontOffer,
        fetchNoteFont: () => void fetchNoteFont(),
        hasUnsavedChangesNow,
        hasUnsavedWorkNow,
        openPageNumbers: openPageNumbersDialog,
        openSearch: search.openSearch,
        openWatermark: openWatermarkDialog,
        print: () => void startPrint(),
        redo: () => {
          if (annotations.canRedo) {
            redoStep()
          }
        },
        rememberViewNow,
        save: saveDocument,
        saveAs: () => void exportPdf(),
        saveFromKey,
        saveForClose,
        selectAll,
        stopLayerWork: () => {
          layerStoppingRef.current = true
          void annotations.cancelOperation()
        },
        snapshotForMove,
        undo: () => {
          if (annotations.canUndo) {
            undoStep()
          }
        },
      }),
      [
        annotations.canRedo,
        annotations.canUndo,
        clearNoteFontOffer,
        exportPdf,
        fetchNoteFont,
        hasUnsavedChangesNow,
        hasUnsavedWorkNow,
        openPageNumbersDialog,
        openWatermarkDialog,
        redoStep,
        rememberViewNow,
        saveDocument,
        saveForClose,
        saveFromKey,
        search.openSearch,
        selectAll,
        snapshotForMove,
        startPrint,
        undoStep,
      ],
    )

    const submitPageNumber = (value: string) => {
      const requestedPage = Number(value)

      if (!pdfDocument || !Number.isInteger(requestedPage)) {
        return
      }

      const pageNumber = Math.min(
        pdfDocument.numPages,
        Math.max(1, requestedPage),
      )
      scrollToPage(pageNumber)
    }

    const navigateFromSidebar = useCallback(
      (pageNumber: number) => {
        scrollToPage(pageNumber)
        sidebar.dismiss()
      },
      [scrollToPage, sidebar],
    )

    // Only the tab on show has one: in the sidebar, or the toolbar while the
    // sidebar is not docked.
    const appMenu = active ? (
      <AppMenu
        {...menu}
        canSave={canSave}
        onCompress={() => setCompressOpen(true)}
        onExportImages={() => setImageExportOpen(true)}
        onPrint={print.preparing ? undefined : () => void startPrint()}
        onSave={saveDocument}
        onSaveAs={() => void exportPdf()}
        onSplit={() => setSplitOpen(true)}
        saveHint={saveHint}
      />
    ) : null

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
        className="app-surface h-svh overflow-hidden"
        data-active={active}
        data-document-session={openedDocument.id}
        hidden={!active}
        id={panelElementId(openedDocument.id)}
        role="tabpanel"
      >
        <SessionHeader
          active={active}
          annotations={annotations}
          appMenu={appMenu}
          bookApplies={bookApplies}
          canSave={canSave}
          document={pdfDocument}
          macOS={macOS}
          onChangeViewMode={changeViewMode}
          onCompress={() => setCompressOpen(true)}
          onExportImages={() => setImageExportOpen(true)}
          onRotate={() => setPageRotations(rotationsAfterRotate)}
          onSave={saveDocument}
          onSaveAs={() => void exportPdf()}
          onSearchClose={search.closeSearch}
          onSearchOpen={search.openSearch}
          onSplit={() => setSplitOpen(true)}
          onToolChange={setActiveTool}
          onUndo={undoStep}
          page={{
            current: currentPage,
            onSubmit: submitPageNumber,
          }}
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
        />

        <AppSidebar
          macOS={macOS}
          menu={appMenu}
          switcher={
            <SidebarPanelSwitch bookmarksApply={bookmarksApply} panel={sidebarPanel} />
          }
        >
          {sidebarPanel === "bookmarks" ? (
            <BookmarkList
              items={pdfDocument.outline}
              onNavigate={navigateFromSidebar}
            />
          ) : (
            <SidebarThumbnails
              active={active}
              canPaste={clipboard !== null}
              currentPage={currentPage}
              cutPages={cutThumbnailPages}
              documentId={pdfDocument.id}
              onCopyPages={pageClipboard.copy}
              onCutPages={pageClipboard.cut}
              onDeletePage={deleteThumbnailPage}
              onFocusChange={setThumbnailsFocused}
              onInsertBlankPage={insertBlankPage}
              onMenuPage={menuThumbnailPage}
              onNavigate={navigateFromSidebar}
              onPastePages={pastePages}
              onReorderPages={reorderPages}
              onRotatePages={rotateThumbnailPages}
              // Stable across renders, unlike a wrapper, so the column's
              // memoised previews skip the session's every re-render.
              onSelectPage={thumbnailSelection.select}
              pages={pdfDocument.pages}
              renderEpochs={annotations.renderEpochs}
              rotations={pageRotations}
              selectedPages={thumbnailSelection.selectedPages}
              thumbnailKeys={thumbnailIdentity.keys}
            />
          )}
        </AppSidebar>

        {/* Mounted while their tab is away too, only hidden: an export still
            running keeps its progress, its failure, and its busy guard. */}
        {imageExportOpen && pdfDocument ? (
          <ImageExportDialog
            document={pdfDocument}
            hidden={!active}
            suggestedName={exportBaseName}
            onExport={annotations.exportArchive}
            onClose={() => setImageExportOpen(false)}
          />
        ) : null}

        {splitOpen && pdfDocument ? (
          <SplitPdfDialog
            document={pdfDocument}
            hidden={!active}
            suggestedName={exportBaseName}
            onExport={annotations.exportArchive}
            onClose={() => setSplitOpen(false)}
          />
        ) : null}

        {compressOpen && pdfDocument ? (
          <CompressExportDialog
            document={pdfDocument}
            hidden={!active}
            suggestedName={exportBaseName}
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

        <div className="flex h-full pt-[calc(var(--toolbar-height)+var(--document-tabs-height))] pl-(--sidebar-inset)">
          {/* The viewer's scroll box cannot host the readout: anything absolute
              inside it is placed against scrolled content and would drift. */}
          <div className="relative min-w-0 flex-1">
            {/* Text drags focus this from script, which can inherit a text
                field's focus ring; it is never a Tab stop, so it needs none. */}
            <main
              className="pdf-scroll-viewport workspace-background relative w-full overflow-auto outline-none"
              data-pdf-scroll-root
              data-tool-cursor={toolCursor}
              ref={viewerRef}
              tabIndex={-1}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                ref={clientBoxRef}
              />
              <PdfViewerLayout
                documentId={pdfDocument.id}
                drafts={rectTool.drafts}
                notes={textNote.previews}
                onPagePaint={onPagePaint}
                fileName={fileName}
                key={pdfDocument.id}
                pages={pdfDocument.pages}
                renderEpochs={annotations.renderEpochs}
                rotations={pageRotations}
                scale={zoom.scale}
                searchMatchesByPage={search.matchesByPage}
                activeSearchIndex={search.activeIndex}
                activeSearchPage={
                  search.activeIndex === null
                    ? null
                    : (search.matches[search.activeIndex]?.pageNumber ?? null)
                }
                onCopyAllText={copyDocumentText}
                captureHighlight={highlightTool.captureSelection}
                textEpochs={annotations.textEpochs}
                textSelectAll={textSelectAll.selectedAll}
                textSelectionDragging={highlightTool.selectionDragging}
                viewMode={viewMode}
                viewerWidth={viewerWidth}
                zoomPreviewing={zoom.zoomPreviewing}
                zoomRequest={zoom.zoomRequest}
              />
            </main>
            <ZoomIndicator flash={zoom.zoomRequest} percent={zoom.zoomPercent} />
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
            preparing={textNote.preparing}
            rotation={rotationForPage(pageRotations, textNote.draft.pageNumber)}
            style={textNoteStyle}
            viewerRef={viewerRef}
          />
        ) : null}

        <SessionDialogs
          active={active}
          pageCount={pdfDocument?.numPages ?? 0}
          pageNumbers={pageNumbers}
          watermarkPreview={{
            document: pdfDocument,
            // Read as the dialog opens, which re-renders the session: the
            // preview takes the page it starts on once, at mount.
            initialPage: currentPage.get(),
            renderEpochs: annotations.renderEpochs,
          }}
          print={print}
          watermark={watermark}
        />
      </div>
    )
  },
)
