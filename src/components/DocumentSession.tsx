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
import { A4ExportDialog } from "@/components/A4ExportDialog"
import { CompressExportDialog } from "@/components/CompressExportDialog"
import { ImageExportDialog } from "@/components/ImageExportDialog"
import { SplitPdfDialog } from "@/components/SplitPdfDialog"
import { PdfSearch } from "@/components/PdfSearch"
import { PdfViewerLayout } from "@/components/PdfViewerLayout"
import { SessionDialogs } from "@/components/SessionDialogs"
import { SessionHeader } from "@/components/SessionHeader"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { FileSectionsTree, type FileSectionsTreeHandle } from "@/components/FileSectionsTree"
import {
  NO_PADDING,
  samePadding,
  sheetSpreads,
  sheetsOf,
  spreadPagesOf,
  spreadTurnTarget,
} from "@/lib/padding"
import { PageThumbnails, type PageThumbnailsHandle } from "@/components/PageThumbnails"
import { AddFilesButton } from "@/components/SidebarPanelTools"
import { TextNoteEditor } from "@/components/TextNoteEditor"
import { ViewerControls } from "@/components/ViewerControls"
import { ZoomIndicator } from "@/components/ZoomIndicator"
import type { AnnotationTool } from "@/components/AnnotationToolbar"
import { useAnnotations, type SignedChange } from "@/hooks/useAnnotations"
import { createCurrentPage } from "@/hooks/useCurrentPage"
import { useCurrentPageTracker } from "@/hooks/useCurrentPageTracker"
import { useDocumentNotices, type NoticeChannel } from "@/hooks/useNotices"
import { usePageClipboard } from "@/hooks/usePageClipboard"
import { usePrint } from "@/hooks/usePrint"
import type { AskSignatures } from "@/hooks/useSignaturePrompt"
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
  followPage,
  movesPages,
  type AnnotationCommand,
  type HexColor,
  type PageChange,
  type RenderEpochs,
  type RectStyle,
  type TextNoteStyle,
} from "@/lib/annotations"
import { copyPlainText } from "@/lib/clipboard"
import { hasLayerOverWorkspace } from "@/lib/contextMenu"
import { panelElementId, tabElementId } from "@/lib/documentTabs"
import { documentPlainText } from "@/lib/documentText"
import type { CarriedPages } from "@/lib/pageCarry"
import { forgetDocumentText } from "@/lib/pageText"
import { transientDocumentRefusals, workspaceOwner } from "@/lib/notices"
import { NO_FOLDS, sectionOutlineKey, type OutlineFolds } from "@/lib/outlineFolds"
import { storedSignatureHandling } from "@/lib/signatureHandling"
import { e2eOverride } from "@/lib/e2e"
import { fileMoveOrder, pagesOfSection } from "@/lib/pageSections"
import {
  answerSourceSignatures,
  readFileSources,
  releaseFileSources,
  storedFileOptions,
} from "@/lib/fileSources"
import { storeFilePreferences } from "@/lib/filePreferences"
import { wordConversionAvailable } from "@/lib/wordConversion"
import {
  formatPageRanges,
  type PageClipboard,
} from "@/lib/pageClipboard"
import {
  exportFailureNotice,
  fileNameFromPath,
  type FileOptions,
  type PdfDocumentInfo,
  type PdfExportOutcome,
  type PdfSignatures,
  type PdfStructureUpdate,
  type SignatureDecision,
} from "@/lib/pdf"
import { turnView } from "@/lib/pageRotation"
import { ParkedPreviews } from "@/lib/parkedPreviews"
import { isMacOS } from "@/lib/platform"
import type {
  MovedSessionSnapshot,
  MovedTabSeed,
} from "@/lib/tabMove"
import type { PdfOwnedLayer, PdfProgress } from "@/lib/progress"
import { type RecentPdfView } from "@/lib/recentFiles"
import type { ZoomShortcut } from "@/lib/shortcuts"
import {
  followPages,
  forgetStashes,
  initialThumbnailIdentity,
} from "@/lib/thumbnailIdentity"
import {
  defaultViewMode,
  effectiveViewMode,
  hasBookSpread,
  pageTurnTarget,
  readStoredViewMode,
  storeViewMode,
  type ViewMode,
} from "@/lib/viewMode"
import { isNoteWorthKeeping } from "@/lib/textNoteDraft"
import { viewerReadingBounds, viewerSizeCommitted } from "@/lib/viewerViewport"
import {
  anchorCorrection,
  anchorOnPage,
  editAnchor,
  editAnchorCorrection,
  type EditAnchor,
} from "@/lib/viewportAnchor"
import { CONTENT_PADDING_X, CONTENT_PADDING_Y } from "@/lib/zoom"

export type DocumentSessionHandle = {
  /** Another tab's pages let go on this one's tab: copies at the end, or null
      where the document cannot take them now. Settles on whether they landed. */
  appendCarriedPages: (carried: CarriedPages) => Promise<boolean> | null
  /** Whether `appendCarriedPages` would take pages now. */
  canTakePagesNow: () => boolean
  /** Lets go of the edit it held: the note's text lives nowhere else by then. */
  dismissNoteFont: () => void
  /** The reader's word on intact signatures before a change, or a new file of
      these pages, breaks them; `true` where none is owed. */
  ensureSignatures: (change: SignedChange) => true | Promise<boolean>
  fetchNoteFont: () => void
  /** Edits and a typed note, which a save would keep; `hasUnsavedWorkNow`
      also counts work still running, which no save can. */
  hasUnsavedChangesNow: () => boolean
  hasUnsavedWorkNow: () => boolean
  /** Whether a save could only write a copy, never the document's own file. */
  isCopyOnlyNow: () => boolean
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
  /** Files added as files of their own where they were let go, a point on
      screen over the sidebar's pages or the outline's files, or at the end. */
  addFiles: (paths: string[], point?: { x: number; y: number }) => void
  redo: () => void
  selectAll: () => void
  undo: () => void
  zoom: (action: ZoomShortcut) => void
}

type DocumentSessionProps = {
  active: boolean
  /** The window's one signature prompt. */
  askSignatures: AskSignatures
  document: PdfDocumentInfo
  /** Another tab's word on its intact signatures before its pages come in. */
  ensureSourceSignatures: (documentId: number) => true | Promise<boolean>
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
  /** A Save As wrote a document of several files to a file of its own: the
      tab now shows that file, as opening it again would. */
  onCombinedSaved: (documentId: number) => void
  onDirtyChange: (documentId: number, dirty: boolean) => void
  /** A copy written to a file of its own that this tab now shows — Save as
      A4's — in place of the document it was made from. */
  onReplacedByFile: (documentId: number, document: PdfDocumentInfo) => void
  /** Whether this document may now be written back over its own file. Only the
      session can say: the workspace cannot see what makes it export-only. */
  onSavableChange: (documentId: number, canSave: boolean) => void
  /** An export that gave a document its first file: the tab now stands for
      that file, not for the bytes it opened from. */
  onSourceChange: (
    documentId: number,
    path: string,
    signatures: PdfDocumentInfo["signatures"],
  ) => void
  recentPath?: string
  saveAsDefaultName?: string
  /** A tab that arrived from another window, replayed here: the state the
      strip could not carry, read once at the first mount. */
  movedSeed?: MovedTabSeed
}

const NO_FILES: ReadonlySet<number> = new Set()

function closePdf(documentId: number) {
  void invoke("close_pdf", { documentId }).catch(() => undefined)
}

export const DocumentSession = forwardRef<DocumentSessionHandle, DocumentSessionProps>(
  function DocumentSession(
    {
      active,
      askSignatures,
      document: openedDocument,
      ensureSourceSignatures,
      fileName,
      initialRecentView,
      initialSaveRequired = false,
      initialViewMode,
      menu,
      notices,
      onCombinedSaved,
      onDirtyChange,
      onReplacedByFile,
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
    // A Save As on the way out: the tab is about to close, so a combined
    // document is not reopened as the file it wrote.
    const savingForCloseRef = useRef(false)
    // Thumbnail canvases follow their pages through every structure edit and its
    // undo: a preview keeps its pixels, and the column shows where it went.
    // Written outside any updater, which StrictMode runs twice, as the previews
    // a page taken out leaves behind are told before the render.
    const [initialIdentity] = useState(() =>
      initialThumbnailIdentity(openedDocument.numPages),
    )
    const thumbnailIdentityRef = useRef(initialIdentity)
    const [thumbnailKeys, setThumbnailKeys] = useState(initialIdentity.keys)
    const [parkedPreviews] = useState(() => new ParkedPreviews())
    // Only the latest structure edit's pages keep their previews: an undo right
    // after it is what brings pages back, and an older one renders them afresh.
    const previewStashRef = useRef<number | undefined>(undefined)
    // A copy of a page carrying a watermark or page numbers leaves the document
    // export-only, like those layers. The backend says so at the open and with
    // every structure update, so no replay.
    const hasMergedPages = pdfDocument.hasMergedPages
    // Another file's pages were added: the reader chose that the file then
    // stays as it was, and the combined pages go to a new one.
    const hasForeignPages = pdfDocument.hasForeignPages
    // Bound to a file whose signatures are intact: any save would break them.
    const signedOriginal = pdfDocument.signatures.intact
    const [currentPage] = useState(() =>
      createCurrentPage(
        Math.min(
          Math.max(initialRecentView?.position.pageNumber ?? 1, 1),
          Math.max(openedDocument.numPages, 1),
        ),
      ),
    )
    const [viewRotation, setViewRotation] = useState(
      () => movedSeed?.viewRotation ?? 0,
    )
    const [imageExportOpen, setImageExportOpen] = useState(false)
    const [splitOpen, setSplitOpen] = useState(false)
    const [compressOpen, setCompressOpen] = useState(false)
    const [a4Open, setA4Open] = useState(false)
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
    // The blank pages a Save As will add, shown and printed where it puts them.
    const padding = pdfDocument.padding ?? NO_PADDING
    // Where the page being read stood before an edit: blanks above it coming
    // or going, a turn reshaping it, pages inserted, taken out or moved around
    // it, any of which can also change a fit's scale. Left alone, the kept
    // scroll offset would show another page; the view holds it there instead.
    const editAnchorRef = useRef<EditAnchor | null>(null)

    useLayoutEffect(() => {
      const anchor = editAnchorRef.current
      const viewer = viewerRef.current

      editAnchorRef.current = null

      if (!anchor || !viewer) {
        return
      }

      const page = viewer.querySelector<HTMLElement>(
        `[data-page-number="${anchor.pageNumber}"]`,
      )

      if (page) {
        viewer.scrollTop += editAnchorCorrection(anchor, page.getBoundingClientRect())
      }
    }, [padding, pdfDocument.pages])

    // An edit replaces the outline wholesale. Deriving what is shown, rather
    // than switching the sidebar, lets the undo that restores bookmarks restore it.
    // A document of several files shows them, and their bookmarks, as a tree.
    const sections = pdfDocument.sections ?? []
    const severalFiles = sections.length > 1
    // Down to one added file, it shows that file's own bookmarks, which a Save
    // As writes, rather than those PDFium keeps for the document's own pages
    // even once none are left; the own pages alone save PDFium's.
    const outlineFile =
      sections.length === 1 && pdfDocument.hasForeignPages ? sections[0]! : undefined
    const outline = outlineFile ? outlineFile.outline : pdfDocument.outline
    const sidebar = useSidebar()
    const thumbnailsRef = useRef<PageThumbnailsHandle>(null)
    const filesTreeRef = useRef<FileSectionsTreeHandle>(null)
    // Either panel shows for any document, whatever it holds: which one is
    // how the reader laid the window out.
    const sidebarPanel = sidebar.panel
    // The files whose pages the sidebar folds away under their names: the
    // tab's own, kept while the sidebar shows something else.
    const [foldedFiles, setFoldedFiles] = useState<ReadonlySet<number>>(NO_FILES)
    // And what the outline folds, kept the same way.
    const [outlineFolds, setOutlineFolds] = useState<OutlineFolds>(NO_FOLDS)

    const scrollToPage = useCallback(
      (pageNumber: number, behavior: ScrollBehavior = "smooth") => {
        const page = viewerRef.current?.querySelector<HTMLElement>(
          `[data-page-number="${pageNumber}"]`,
        )

        currentPage.goTo(pageNumber)
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
      padding,
      pages: pdfDocument.pages,
      viewMode,
      viewRotation,
      viewerRef,
    })
    // The previews are where pages are chosen while they show; hiding them
    // lets go of what was chosen.
    const thumbnailsShown = sidebar.mode !== "hidden" && sidebarPanel === "thumbnails"
    // The clipboard and select-all keys are the pages' while focus is in the
    // sidebar's column: elsewhere they are the text's, as they always were.
    const [pageKeys, setThumbnailsFocused] = useState(false)
    const thumbnailSelection = useThumbnailSelection({
      active: active && thumbnailsShown,
      currentPage,
      numPages: pdfDocument.numPages,
    })
    const clearThumbnailSelection = thumbnailSelection.clear
    const deselectPages = thumbnailSelection.deselect
    const foldFiles = useCallback(
      (sectionIds: readonly number[], folded: boolean) => {
        setFoldedFiles((current) => {
          const next = new Set(current)

          for (const sectionId of sectionIds) {
            if (folded) {
              next.add(sectionId)
            } else {
              next.delete(sectionId)
            }
          }

          return next
        })

        // A page chosen and then folded away would be deleted or cut with
        // nothing on screen to say so: folding a file lets go of its pages.
        if (folded) {
          const files = new Set(sectionIds)

          deselectPages(
            (documentRef.current?.pages ?? []).flatMap((page, index) =>
              page.section !== undefined && files.has(page.section) ? [index + 1] : [],
            ),
          )
        }
      },
      [deselectPages],
    )
    // The paste's own work needs the history below, which is set up after this;
    // the hook only ever calls it from a keypress, by which time it is here.
    const pastePagesRef = useRef<(index: number) => void>(() => {})
    const pageClipboard = usePageClipboard({
      active: active && thumbnailsShown && pageKeys,
      onCutCancelled: useCallback(() => notice.retract(["pagesCut"]), [notice]),
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
      shown: active && thumbnailsShown,
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
      active: active && !pageKeys,
      onCopy: copyDocumentText,
    })
    const selectAllPages = thumbnailSelection.selectAll
    const selectAllText = textSelectAll.selectAll
    // Where the workspace's select-all shortcut lands: the sidebar's previews
    // hold pages, and the page views hold the text laid over them.
    const selectAll = useCallback(() => {
      if (pageKeys && thumbnailsShown) {
        selectAllPages()
      } else {
        selectAllText()
      }
    }, [pageKeys, selectAllPages, selectAllText, thumbnailsShown])
    // One prompt per document: a second asker waits for the first's answer,
    // which the backend records and reports back as the document's own.
    const askSignaturesRef = useRef(askSignatures)
    const decisionGateRef = useRef<Promise<SignatureDecision | null> | null>(null)
    const flattenGateRef = useRef<Promise<boolean> | null>(null)
    const flattenRef = useRef<(pageCount: number) => Promise<boolean>>(() =>
      Promise.resolve(false),
    )
    // A remembered flatten is announced once it worked; after a failed one the
    // reader is asked, as its notice offers keeping the fields instead.
    const announceFlattenRef = useRef(false)
    const askAfterFailedFlattenRef = useRef(false)

    useLayoutEffect(() => {
      askSignaturesRef.current = askSignatures
    }, [askSignatures])

    const decideSignatures = useCallback(
      async (change: SignedChange) => {
        const current = documentRef.current

        if (!current) {
          return null
        }

        const remembered = askAfterFailedFlattenRef.current
          ? "ask"
          : storedSignatureHandling()
        askAfterFailedFlattenRef.current = false
        const answer =
          remembered === "ask"
            ? ((
                await askSignaturesRef.current({
                  context: change,
                  count: current.signatures.count,
                  name: fileName,
                })
              )?.decision ?? null)
            : remembered

        if (!answer) {
          return null
        }

        try {
          const signatures = await invoke<PdfSignatures>("decide_pdf_signatures", {
            decision: answer,
            documentId: current.id,
          })
          const latest = documentRef.current

          if (latest?.id === current.id) {
            const next = { ...latest, signatures }

            documentRef.current = next
            setPdfDocument(next)
          }

          // Said of what the backend holds, which is what the change will do.
          if (remembered !== "ask" && signatures.decision === "keep") {
            notice.raise("signaturesKeptAsSet")
          } else if (remembered !== "ask" && signatures.decision === "flatten") {
            // A new file flattens its own copy, out of this document's sight.
            if (change === "export") {
              notice.raise("signaturesFlattenedAsSet")
            } else {
              announceFlattenRef.current = true
            }
          }

          return signatures.decision
        } catch {
          notice.raise(change === "export" ? "exportFailed" : "annotateFailed")
          return null
        }
      },
      [fileName, notice],
    )

    // A flatten answer draws the signatures in before the first edit; a new
    // file of the pages flattens its own copy, leaving this document as it is.
    const settleSignatures = useCallback(
      (change: SignedChange, decision: SignatureDecision): true | Promise<boolean> => {
        if (change === "export" || decision === "keep") {
          return true
        }

        flattenGateRef.current ??= flattenRef
          .current(documentRef.current?.numPages ?? 0)
          .then((flattened) => {
            const current = documentRef.current
            const announce = announceFlattenRef.current

            announceFlattenRef.current = false

            if (flattened && announce) {
              notice.raise("signaturesFlattenedAsSet")
            }

            // Asked again next time, where keeping the fields still works.
            if (!flattened && current) {
              askAfterFailedFlattenRef.current = true
              const next = {
                ...current,
                signatures: { ...current.signatures, decision: null },
              }

              documentRef.current = next
              setPdfDocument(next)
              notice.raise("signaturesFlattenFailed")
            }

            return flattened
          })
          .finally(() => {
            flattenGateRef.current = null
          })

        return flattenGateRef.current
      },
      [notice],
    )

    const ensureSignatures = useCallback(
      (change: SignedChange): true | Promise<boolean> => {
        const signatures = documentRef.current?.signatures

        if (!signatures?.intact || signatures.flattened) {
          return true
        }

        if (signatures.decision !== null) {
          return settleSignatures(change, signatures.decision)
        }

        decisionGateRef.current ??= decideSignatures(change).finally(() => {
          decisionGateRef.current = null
        })

        return decisionGateRef.current.then((decision) =>
          decision === null ? false : settleSignatures(change, decision),
        )
      },
      [decideSignatures, settleSignatures],
    )

    const annotations = useAnnotations({
      beforeCopyFrom: ensureSourceSignatures,
      beforeSignedChange: ensureSignatures,
      documentId: pdfDocument.id,
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

          const next = { ...current, path: outcome.path, signatures: outcome.signatures }
          saveRequiredRef.current = false
          setSaveRequired(false)
          documentRef.current = next
          setPdfDocument(next)
          onSourceChange(documentId, outcome.path, next.signatures)

          if (current.hasForeignPages && !savingForCloseRef.current) {
            onCombinedSaved(documentId)
          }
        },
        [onCombinedSaved, onSourceChange],
      ),
      onSaveError: useCallback(
        () => notice.raise("saveFailed"),
        [notice],
      ),
      onStashesDropped: useCallback(
        (stashIds: number[]) => {
          thumbnailIdentityRef.current = forgetStashes(
            thumbnailIdentityRef.current,
            stashIds,
          )

          if (
            previewStashRef.current !== undefined &&
            stashIds.includes(previewStashRef.current)
          ) {
            previewStashRef.current = undefined
            parkedPreviews.want([])
            parkedPreviews.prune()
          }
        },
        [parkedPreviews],
      ),
      // A structure command replaces the page list wholesale; where it moved the
      // pages, bring each position-derived state back into range.
      onStructureChange: useCallback(
        (
          documentId: number,
          update: PdfStructureUpdate,
          change?: PageChange,
        ) => {
          const current = documentRef.current

          if (!current || current.id !== documentId) {
            return
          }

          const movement = change?.movement
          const viewer = viewerRef.current
          const bounds = viewer ? viewerReadingBounds(viewer) : null
          const readingTop = bounds?.top ?? 0
          // Only a page on screen holds the reader's place: mid-seek, the
          // tracked page is pages off, and the scroll held to it would stop there.
          const pageAt = (pageNumber: number) => {
            const page = viewer?.querySelector<HTMLElement>(`[data-page-number="${pageNumber}"]`)
            const box = page?.getBoundingClientRect()

            return box && bounds && box.bottom > bounds.top && box.top < bounds.bottom
              ? page
              : undefined
          }
          // The page being read, or the one taking its place, by its number
          // after an edit that moved the pages.
          let reading: number | undefined

          if (movement === "inPlace") {
            const page = samePadding(current.padding ?? NO_PADDING, update.padding ?? NO_PADDING)
              ? // A turn: the page gone to stays where it stood, though the view
                // could not bring it to the top.
                pageAt(currentPage.get())
              : // The page under the viewer's top edge as laid out now: the page
                // tracked as current follows scrolling a moment behind.
                Array.from(
                  viewer?.querySelectorAll<HTMLElement>("[data-page-number]") ?? [],
                ).find((candidate) => candidate.getBoundingClientRect().bottom > readingTop)

            editAnchorRef.current = page
              ? editAnchor(Number(page.dataset.pageNumber), page.getBoundingClientRect(), readingTop)
              : null
          } else if (movement) {
            const page = pageAt(currentPage.get())

            reading = followPage(movement, currentPage.get())

            editAnchorRef.current = page
              ? editAnchor(
                  reading,
                  page.getBoundingClientRect(),
                  readingTop,
                  movement[reading - 1] !== currentPage.get(),
                )
              : null
            zoom.followFitPage(movement)
          }

          const next = {
            ...current,
            hasForeignPages: update.hasForeignPages,
            hasMergedPages: update.hasMergedPages,
            numPages: update.numPages,
            outline: update.outline,
            splitsByBookmarks: update.splitsByBookmarks,
            fileOptions: update.fileOptions,
            padding: update.padding,
            pages: update.pages,
            sections: update.sections,
            signatures: update.signatures,
          }

          documentRef.current = next
          setPdfDocument(next)

          // Turned where it stands, so every position still holds its page — a
          // second press of the rotation must still find the selection it turns.
          if (change?.movement === "inPlace") {
            currentPage.reland()
            return
          }

          // A note held for its font names the page it was typed on, which
          // now holds other content: gone is better than landing elsewhere.
          clearNoteFontOffer()

          const identity = followPages(
            thumbnailIdentityRef.current,
            update.numPages,
            change,
          )

          thumbnailIdentityRef.current = identity
          setThumbnailKeys(identity.keys)
          // Before the render that unmounts them: a preview parks only if wanted.
          previewStashRef.current = change?.stashId
          parkedPreviews.want(
            change?.stashId === undefined ? [] : (identity.parked.get(change.stashId) ?? []),
          )
          currentPage.renumbered(
            reading ??
              Math.min(Math.max(currentPage.get(), 1), Math.max(1, update.numPages)),
            editAnchorRef.current !== null,
          )
          clearThumbnailSelection()
          // The page numbers on the clipboard now name other pages — unless this
          // is the paste's own insert, which says how far they slid.
          pageClipboardStructureChanged(update.numPages)
        },
        [
          clearNoteFontOffer,
          clearThumbnailSelection,
          currentPage,
          pageClipboardStructureChanged,
          parkedPreviews,
          zoom.followFitPage,
        ],
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

    useLayoutEffect(() => {
      flattenRef.current = annotations.flattenSignatures
    }, [annotations.flattenSignatures])

    // Asked as a drawing tool is picked, not at the end of its first stroke
    // or typed note, which a cancelled prompt would then throw away.
    const chooseTool = useCallback(
      (tool: AnnotationTool) => {
        if (tool === null) {
          setActiveTool(tool)
          return
        }

        if (tool === "eraser") {
          setActiveTool(tool)
          return
        }

        const ready = ensureSignatures("edit")

        if (ready === true) {
          setActiveTool(tool)
        } else {
          void ready.then((allowed) => {
            if (allowed) {
              setActiveTool(tool)
            }
          })
        }
      },
      [ensureSignatures],
    )

    // After the commit new keys land in: a page brought back has taken its
    // preview by then, if its column is up, and what is left is let go.
    useEffect(() => parkedPreviews.prune(), [parkedPreviews, thumbnailKeys])
    useEffect(() => () => parkedPreviews.clear(), [parkedPreviews])

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
      documentId: pdfDocument.id,
      documentPages: pdfDocument.pages,
      sessionId: openedDocument.id,
      textEpochs: annotations.textEpochs,
      viewerRef,
      viewMode,
    })

    // One batch at a time: a second, while the first is still being read or
    // converted, would be placed against a page count about to move.
    const addingFilesRef = useRef(false)

    /** Files read from disk, added as files of their own in front of the
        page `slot` pages in, or at the end; signed ones wait for the reader's
        word on their signatures, as a new file made of their pages would. */
    const addFiles = useCallback(
      async (paths: string[], slot?: number | null) => {
        if (paths.length === 0) {
          return
        }

        // By key, as pages are followed through edits: a read may take
        // minutes, and an edit landing meanwhile renumbers the pages.
        const beforeKey =
          slot === undefined || slot === null ? undefined : thumbnailIdentityRef.current.keys[slot]

        // Said, not swallowed: the reader let these files go here.
        if (addingFilesRef.current) {
          notice.raise("pagesAppendBusy", { values: { name: fileName } })
          return
        }

        addingFilesRef.current = true
        let read: Awaited<ReturnType<typeof readFileSources>> = []

        try {
          read = await readFileSources(paths, notices)

          if (read.length === 0) {
            return
          }

          const answers = await answerSourceSignatures(read, (request) =>
            askSignaturesRef.current(request),
          )

          if (!answers) {
            return
          }

          // The end as it stands once queued edits land: a read may take
          // minutes, and an edit still in flight would move it.
          await annotations.settled()
          const current = documentRef.current

          if (!current) {
            return
          }

          const before =
            beforeKey === undefined ? -1 : thumbnailIdentityRef.current.keys.indexOf(beforeKey)
          const landed = await annotations.insertFiles(
            read.flatMap((info) =>
              info.id === undefined
                ? []
                : [{ id: info.id, pages: info.pages.length, title: fileNameFromPath(info.path) }],
            ),
            before < 0 ? current.numPages + 1 : before + 1,
            current.numPages,
            {
              options: storedFileOptions(),
              ownTitle: fileName,
              signatures: answers.signatures,
            },
          )

          if (landed === "changed") {
            notice.raise("filesChanged")
          }

          if (landed === true && answers.asSet) {
            notice.raise(
              answers.asSet === "flatten" ? "signaturesFlattenedAsSet" : "signaturesKeptAsSet",
            )
          }
        } finally {
          addingFilesRef.current = false

          // An add that landed took its sources with it; any other lets them
          // go, or a signed one would keep its file from every writer.
          releaseFileSources(read)
        }
      },
      [annotations, fileName, notice, notices],
    )

    // The backend's own dialog, which also approves the chosen files for reading.
    const chooseFiles = useCallback(async () => {
      try {
        const pick = e2eOverride("pickPdfPaths")
        const paths = pick
          ? await pick()
          : await invoke<string[]>("pick_pdf_paths", {
              filterLabel: t(
                wordConversionAvailable()
                  ? "files.sourceFilter"
                  : "files.sourceFilterPlain",
              ),
            })

        await addFiles(paths)
      } catch {
        notice.raise("openFailed")
      }
    }, [addFiles, notice, t])

    const renameSection = useCallback(
      (sectionId: number, title: string) => {
        const previous = documentRef.current?.sections?.find(
          (section) => section.id === sectionId,
        )?.title

        if (previous !== undefined) {
          void annotations.renameSection(sectionId, title, previous)
        }
      },
      [annotations],
    )

    /** Undoable for this document, and remembered as the reader's choice for
        the next document files are added to. */
    const changeFileOptions = useCallback(
      (change: Partial<FileOptions>) => {
        if (!documentRef.current?.fileOptions) {
          return
        }

        void annotations.setFileOptions(change, () => documentRef.current?.fileOptions)
        // Only the choice made: another window may have changed the other since.
        storeFilePreferences({
          bookmarks: change.perFileBookmarks,
          smartPadding: change.smartPadding,
        })
      },
      [annotations],
    )

    /** Every page of the file, wherever they stand: one undo puts them back. */
    const removeSection = useCallback(
      (sectionId: number) => {
        const current = documentRef.current

        if (!current || annotations.isStructureBusyNow()) {
          return
        }

        const pages = current.pages.flatMap((page, index) =>
          page.section === sectionId ? [index + 1] : [],
        )

        void annotations.deletePages(pages, current.numPages)
      },
      [annotations],
    )

    const pageOps = useThumbnailPageOps({
      annotations,
      pageClipboard,
      pdfDocument,
      notice,
      thumbnailSelection,
    })
    // The handle is not rebuilt per render; an append counts the pages now.
    const pageOpsRef = useRef(pageOps)

    useLayoutEffect(() => {
      pageOpsRef.current = pageOps
    })

    const {
      deleteThumbnailPage,
      insertBlankPage,
      insertCarriedPages,
      menuThumbnailPage,
      pastePages,
      reorderPages,
      rotateOnePage,
      rotateThumbnailPages,
    } = pageOps

    // A file dragged in the sidebar's tree keeps its own pages, wherever it
    // goes: in front of 1-based page `before`, or to the end. Not memoised:
    // `reorderPages` is new every render.
    const moveFile = (sectionId: number, before: number | null) => {
      const pages = documentRef.current?.pages ?? []
      const order = fileMoveOrder(pages, sectionId, before)

      if (order) {
        void reorderPages(order, pagesOfSection(pages, sectionId))
      }
    }

    // From the file's name in the sidebar's tree: in front of 1-based page
    // `index`, as one of that file's pages.
    const pasteIntoFile = (sectionId: number, index: number) => pastePages(index, sectionId)

    const watermark = useWatermark({
      activeConfig: annotations.watermarkConfig,
      defaultText: t("watermark.defaultText"),
      documentId: pdfDocument.id,
      onCancel: annotations.cancelOperation,
      onSet: annotations.setWatermark,
      pageCount: pdfDocument.numPages,
    })
    const pageNumbers = usePageNumbers({
      activeConfig: annotations.pageNumbersConfig,
      documentId: pdfDocument.id,
      onCancel: annotations.cancelOperation,
      onSet: annotations.setPageNumbers,
      pageCount: pdfDocument.numPages,
    })
    // Named apart from the hooks so the window's keys and the toolbar's buttons
    // open the one dialog; both openers are stable.
    const openWatermarkDialog = watermark.openDialog
    const openPageNumbersDialog = pageNumbers.openDialog
    const print = usePrint({
      documentId: pdfDocument.id,
      onError: () => notice.raise("printFailed"),
      padding,
      pages: pdfDocument.pages,
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
      viewRotation,
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
      pages: pdfDocument.pages,
      selectable: textSelectable,
      viewRotation,
      viewerRef,
    })

    const drawingRect = activeTool === "rect"
    const rectTool = useRectTool({
      active: active && drawingRect,
      onCommit: annotations.commit,
      pages: pdfDocument.pages,
      style: rectStyle,
      viewRotation,
      viewerRef,
    })

    const erasing = activeTool === "eraser"
    useEraserTool({
      active: active && erasing,
      onErase: annotations.eraseAt,
      pages: pdfDocument.pages,
      viewRotation,
      viewerRef,
    })

    const drawingTextNote = activeTool === "textNote"
    const textNote = useTextNoteTool({
      active: drawingTextNote,
      onCommit: annotations.commit,
      suspended: !active,
      pages: pdfDocument.pages,
      style: textNoteStyle,
      viewRotation,
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

    // What every export names its file after: a converted document's own PDF
    // name, else the file the document came from, else the
    // tab's — never a Word or image source's name with its extension still on.
    const exportBaseName =
      saveAsDefaultName ??
      (pdfDocument.path ? fileNameFromPath(pdfDocument.path) : fileName)

    // The destination dialog is the backend's own, so this only says *that* an
    // export happens; `onExportError` reports a failed write.
    // A copy-only document may not go over the file it came from.
    const isCopyOnlyNow = useCallback(
      () =>
        Boolean(documentRef.current?.path) &&
        (annotations.hasOwnedContentNow() ||
          documentRef.current?.hasMergedPages === true ||
          documentRef.current?.hasForeignPages === true ||
          documentRef.current?.signatures.intact === true),
      [annotations],
    )

    const exportPdf = useCallback(() => {
      // Its own name is the one suggestion bound to be refused.
      const name = isCopyOnlyNow()
        ? `${exportBaseName.replace(/\.pdf$/i, "")}-${t("annotate.copySuffix")}.pdf`
        : exportBaseName

      return annotations.exportCopy(name, t("annotate.exportFilter"))
    }, [annotations, exportBaseName, isCopyOnlyNow, t])

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
      currentPage,
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
        // A spread is two sheets, a blank a Save As will add among them.
        const spreads = sheetSpreads(sheetsOf(pdfDocument.numPages, padding))
        const direction = event.key === "PageDown" ? 1 : -1
        const target =
          viewMode === "book"
            ? spreadTurnTarget(spreads, current, direction)
            : pageTurnTarget(current, pdfDocument.numPages, direction)
        const currentRow =
          viewMode === "book" ? (spreadPagesOf(spreads, current)[0] ?? current) : current

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
    }, [active, currentPage, padding, pdfDocument.numPages, scrollToPage, viewMode])

    // Each mode stacks pages to a different height, so the kept offset would land
    // somewhere unrelated; queued here, ahead of the next render's layout effects.
    const changeViewMode = (mode: ViewMode) => {
      if (mode !== viewMode) {
        pendingScrollPageRef.current = currentPage.get()
      }

      setPreferredViewMode(mode)
    }

    const openSearch = search.openSearch

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
      recentPath,
      viewMode,
      viewRotation,
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
          history: annotationsSeed.history,
          marks: annotationsSeed.marks,
          viewMode: preferredViewMode,
          viewRotation,
        },
      }
    }, [
      annotations,
      preferredViewMode,
      sampleCurrentView,
      textNote.draft?.text,
      viewRotation,
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
    const hasSourceFile = Boolean(pdfDocument.path)
    const canSave =
      hasSourceFile &&
      annotations.isDirty &&
      !hasOwnedContent &&
      !hasMergedPages &&
      !hasForeignPages &&
      !signedOriginal
    // Only where the reason is not already in front of the reader. Owned page
    // content is named first — it is the stricter, less recoverable reason.
    const saveHint = hasOwnedContent
      ? t("annotate.saveOwnedContent")
      : signedOriginal
        ? t("annotate.saveSigned")
        : hasForeignPages
          ? t("annotate.saveForeign")
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
      } else if (!hasSourceFile || hasForeignPages) {
        // Where the save control itself is Save As, so is its key.
        void exportPdf()
      } else if (hasOwnedContent) {
        notice.raise("saveOwnedContentOnly")
      } else if (signedOriginal) {
        notice.raise("saveSignedOnly")
      } else if (hasMergedPages) {
        notice.raise("saveMergedOnly")
      }
    }, [
      annotations,
      canSave,
      exportPdf,
      hasForeignPages,
      hasMergedPages,
      hasOwnedContent,
      hasSourceFile,
      notice,
      signedOriginal,
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
        !documentRef.current?.hasMergedPages &&
        !documentRef.current?.hasForeignPages &&
        !documentRef.current?.signatures.intact

      if (writesBack) {
        return annotations.save()
      }

      savingForCloseRef.current = true

      try {
        return (await exportPdf()) === "saved"
      } finally {
        savingForCloseRef.current = false
      }
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
        // Whichever of the two lists shows: the pages, or the outline's files.
        addFiles: (paths, point) =>
          void addFiles(
            paths,
            point &&
              (thumbnailsRef.current?.fileDropSlot(point) ??
                filesTreeRef.current?.fileDropSlot(point)),
          ),
        appendCarriedPages: (carried) => pageOpsRef.current.appendCarriedPages(carried),
        canTakePagesNow: () => pageOpsRef.current.canTakeCarriedPages(),
        dismissNoteFont: clearNoteFontOffer,
        ensureSignatures,
        fetchNoteFont: () => void fetchNoteFont(),
        hasUnsavedChangesNow,
        hasUnsavedWorkNow,
        isCopyOnlyNow,
        openPageNumbers: openPageNumbersDialog,
        openSearch,
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
        // A key leaves the eye on the page, far from the bar's readout.
        zoom: (action) => {
          if (action === "in") {
            zoom.zoomIn({ announce: true })
          } else if (action === "out") {
            zoom.zoomOut({ announce: true })
          } else {
            zoom.applyPreset("actual-size", { announce: true })
          }
        },
      }),
      [
        annotations.canRedo,
        annotations.canUndo,
        clearNoteFontOffer,
        ensureSignatures,
        exportPdf,
        fetchNoteFont,
        hasUnsavedChangesNow,
        hasUnsavedWorkNow,
        isCopyOnlyNow,
        openPageNumbersDialog,
        openWatermarkDialog,
        redoStep,
        rememberViewNow,
        saveDocument,
        saveForClose,
        saveFromKey,
        openSearch,
        selectAll,
        snapshotForMove,
        startPrint,
        undoStep,
        zoom.applyPreset,
        zoom.zoomIn,
        zoom.zoomOut,
      ],
    )

    const submitPageNumber = (value: string) => {
      const requestedPage = Number(value)

      if (!Number.isInteger(requestedPage)) {
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

    const appMenu = (
      <AppMenu
        {...menu}
        canSave={canSave}
        onCompress={() => setCompressOpen(true)}
        onExportImages={() => setImageExportOpen(true)}
        onAddFiles={() => void chooseFiles()}
        onPrint={print.preparing ? undefined : () => void startPrint()}
        onSave={saveDocument}
        onSaveA4={() => setA4Open(true)}
        onSaveAs={() => void exportPdf()}
        onSplit={() => setSplitOpen(true)}
        saveHint={saveHint}
      />
    )

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
          canSave={canSave}
          macOS={macOS}
          onCompress={() => setCompressOpen(true)}
          onSaveA4={() => setA4Open(true)}
          onExportImages={() => setImageExportOpen(true)}
          onSave={saveDocument}
          onSaveAs={() => void exportPdf()}
          onSearchClose={search.closeSearch}
          saveAsOnly={hasForeignPages}
          onSearchOpen={openSearch}
          onSplit={() => setSplitOpen(true)}
          onToolChange={chooseTool}
          onRedo={redoStep}
          onUndo={undoStep}
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
        />

        <AppSidebar
          macOS={macOS}
          footer={<AddFilesButton onClick={() => void chooseFiles()} />}
          switcher={<SidebarPanelSwitch panel={sidebarPanel} />}
        >
          {sidebarPanel === "bookmarks" && severalFiles ? (
            <FileSectionsTree
              canPaste={clipboard !== null}
              folds={outlineFolds}
              onFoldsChange={setOutlineFolds}
              onMove={moveFile}
              onNavigate={navigateFromSidebar}
              onPaste={pasteIntoFile}
              onRemove={removeSection}
              onRename={renameSection}
              pages={pdfDocument.pages}
              ref={filesTreeRef}
              sections={sections}
            />
          ) : sidebarPanel === "bookmarks" ? (
            <BookmarkList
              folds={outlineFolds}
              items={outline}
              onFoldsChange={setOutlineFolds}
              onNavigate={navigateFromSidebar}
              rootKey={outlineFile ? sectionOutlineKey(outlineFile.id) : undefined}
            />
          ) : (
            <PageThumbnails
              active={active}
              busy={annotations.isBusy}
              canPaste={clipboard !== null}
              currentPage={currentPage}
              cutPages={cutThumbnailPages}
              documentId={pdfDocument.id}
              fileOptions={pdfDocument.fileOptions}
              fileRows={sidebar.fileRows}
              foldedFiles={foldedFiles}
              isEditingNow={annotations.isStructureBusyNow}
              onCopyPages={pageClipboard.copy}
              onCutPages={pageClipboard.cut}
              onDeletePage={deleteThumbnailPage}
              onFileOptionsChange={changeFileOptions}
              onFileRowsChange={sidebar.setFileRows}
              onFocusChange={setThumbnailsFocused}
              onFoldFiles={foldFiles}
              onInsertBlankPage={insertBlankPage}
              onInsertCarriedPages={insertCarriedPages}
              onMenuPage={menuThumbnailPage}
              onNavigate={navigateFromSidebar}
              onPastePages={pastePages}
              onRemoveFile={removeSection}
              onRenameFile={renameSection}
              onReorderPages={reorderPages}
              onRotatePage={rotateOnePage}
              onRotatePages={rotateThumbnailPages}
              // Stable across renders, unlike a wrapper, so the memoised
              // previews skip the session's every re-render.
              onSelectPage={thumbnailSelection.select}
              onSelectPages={thumbnailSelection.selectGroup}
              padding={padding}
              pages={pdfDocument.pages}
              parkedPreviews={parkedPreviews}
              ref={thumbnailsRef}
              renderEpochs={annotations.renderEpochs}
              sections={sections}
              selectedPages={thumbnailSelection.selectedPages}
              thumbnailKeys={thumbnailKeys}
              viewRotation={viewRotation}
            />
          )}
        </AppSidebar>

        {/* Mounted while their tab is away too, only hidden: an export still
            running keeps its progress, its failure, and its busy guard. */}
        {imageExportOpen ? (
          <ImageExportDialog
            document={pdfDocument}
            hidden={!active}
            suggestedName={exportBaseName}
            onExport={annotations.exportArchive}
            onClose={() => setImageExportOpen(false)}
          />
        ) : null}

        {splitOpen ? (
          <SplitPdfDialog
            document={pdfDocument}
            hidden={!active}
            suggestedName={exportBaseName}
            onExport={annotations.exportArchive}
            onClose={() => setSplitOpen(false)}
          />
        ) : null}

        {a4Open ? (
          <A4ExportDialog
            document={pdfDocument}
            hidden={!active}
            keepsOriginal={annotations.isDirty || saveRequired}
            onClose={() => setA4Open(false)}
            onExport={annotations.exportA4}
            onSaved={(saved) => {
              setA4Open(false)

              // The corner's, not this tab's: the copy takes the tab's place.
              if (saved.layersScaled) {
                notices.raise({ kind: "a4LayersScaled", owner: workspaceOwner })
              }

              onReplacedByFile(openedDocument.id, saved.document)
            }}
            suggestedName={exportBaseName}
          />
        ) : null}

        {compressOpen ? (
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

        <div className="flex h-full pt-[calc(var(--toolbar-height)+var(--document-tabs-height))] pb-(--status-bar-height) pl-(--sidebar-inset)">
          {/* The viewer's scroll box cannot host the readout or the bars:
              anything absolute inside it is placed against scrolled content
              and would drift. */}
          <div className="relative min-w-0 flex-1">
            {/* Text drags focus this from script, which can inherit a text
                field's focus ring; it is never a Tab stop, so it needs none. */}
            <main
              className="pdf-scroll-viewport overlay-scroll-viewport workspace-background relative w-full overflow-auto outline-none"
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
                padding={padding}
                documentId={pdfDocument.id}
                drafts={rectTool.drafts}
                notes={textNote.previews}
                onPagePaint={onPagePaint}
                fileName={fileName}
                key={pdfDocument.id}
                pages={pdfDocument.pages}
                renderEpochs={annotations.renderEpochs}
                scale={zoom.scale}
                searchMatchesByPage={search.matchesByPage}
                activeSearchIndex={search.activeIndex}
                activeSearchPage={
                  search.activeIndex === null
                    ? null
                    : (search.matches[search.activeIndex]?.pageNumber ?? null)
                }
                onCopyAllText={copyDocumentText}
                onDismissPadding={() => changeFileOptions({ smartPadding: false })}
                captureHighlight={highlightTool.captureSelection}
                textEpochs={annotations.textEpochs}
                textSelectAll={textSelectAll.selectedAll}
                textSelectionDragging={highlightTool.selectionDragging}
                viewMode={viewMode}
                viewRotation={viewRotation}
                viewerWidth={viewerWidth}
                zoomPreviewing={zoom.zoomPreviewing}
                zoomRequest={zoom.zoomRequest}
              />
            </main>
            <OverlayScrollbars viewportRef={viewerRef} />
            <ZoomIndicator flash={zoom.zoomAnnouncement} percent={zoom.zoomPercent} />
            <ViewerControls
              bookApplies={bookApplies}
              onChangeViewMode={changeViewMode}
              onRotate={() => setViewRotation(turnView)}
              page={{
                count: pdfDocument.numPages,
                current: currentPage,
                onSubmit: submitPageNumber,
              }}
              viewMode={viewMode}
              zoom={zoom}
            />
          </div>
        </div>

        {/* Outside the viewer's scroll box, in the screen space it positions
            itself against — inside, it would scroll away with the page it is on. */}
        {textNote.draft && pdfDocument.pages[textNote.draft.pageNumber - 1] ? (
          <TextNoteEditor
            draft={textNote.draft}
            editorRef={textNote.editorRef}
            onCancel={textNote.cancel}
            onCommit={textNote.commit}
            onStyleChange={changeTextNoteStyle}
            onTextChange={textNote.setText}
            page={pdfDocument.pages[textNote.draft.pageNumber - 1]!}
            preparing={textNote.preparing}
            rotation={viewRotation}
            style={textNoteStyle}
            viewerRef={viewerRef}
          />
        ) : null}

        <SessionDialogs
          active={active}
          pageCount={pdfDocument.numPages}
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
