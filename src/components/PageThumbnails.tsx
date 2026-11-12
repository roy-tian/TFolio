import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { useTranslation } from "react-i18next"

import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import type { PageActionHandler } from "@/components/PageCardControls"
import {
  landingBox,
  liftGhost,
  PageDragGhost,
  type PageDragGhostHandle,
  type PageDragGhostState,
} from "@/components/PageDragGhost"
import { FileMenuContent, PageMenuContent } from "@/components/PageContextMenu"
import {
  CarriedHoles,
  FILE_HEADING_NAME,
  FileHeading,
  foldedBarKey,
  PageCell,
  PaddingCell,
  PagesDropTarget,
} from "@/components/PageThumbnailCells"
import { PagesBar } from "@/components/PagesBar"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"
import { useFlipLayout } from "@/hooks/useFlipLayout"
import { CARRY_KEY, useIncomingPages } from "@/hooks/useIncomingPages"
import { usePageCarryContext, type CarryLanding } from "@/hooks/usePageCarry"
import {
  sidebarDropPoint,
  subscribeSidebarDropPoint,
  useDropEdgeScroll,
  useSidebarDrop,
} from "@/hooks/useSidebarDrop"
import type { RenderEpochs } from "@/lib/annotations"
import { isTypingTarget } from "@/lib/contextMenu"
import { storedFileOptions } from "@/lib/fileSources"
import { stripSpotAt, type CarriedPages } from "@/lib/pageCarry"
import {
  besideColumn,
  columnEdgeStep,
  exceedsDragThreshold,
  flowCells,
  flowLanding,
  nearestBox,
  orderWithBlockAt,
  pagesBeforeSlot,
  pointInColumn,
  slotOfPages,
  type WeighedFlowCell,
} from "@/lib/pageDrag"
import { flowItems } from "@/lib/pageFlow"
import type { ParkedPreviews } from "@/lib/parkedPreviews"
import { paddingAroundDropped, paddingPositions, type PaddingSheet } from "@/lib/padding"
import { emptiesItsFile, fileRuns, pagesOfSection } from "@/lib/pageSections"
import type { FileOptions, PdfPageInfo, PdfSection } from "@/lib/pdf"
import { THUMBNAIL_COLUMN_GAP, THUMBNAIL_GRID_GAP, thumbnailColumns } from "@/lib/sidebar"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_WIDTH } from "@/lib/viewMode"

// The click a drag ends on belongs to the drag; one later than this is a choice.
const DRAG_CLICK_GRACE_MS = 300
const NO_HOLES: ReadonlySet<number> = new Set()
const NO_PAGES: ReadonlySet<number> = new Set()
// What a ghost lands on in its cell: a page's paper, or a folded file's name.
const LANDING_PAPER = `[data-thumbnail-page], ${FILE_HEADING_NAME}`

export type PageThumbnailsHandle = {
  /** Where files let go at a point on screen would go: the count of pages
      before them, the page count past the last. */
  fileDropSlot: (point: { x: number; y: number }) => number | null
}

type ColumnDrag = {
  /** The page list the drag was measured against: an edit landing under it
      ends the preview, and the reorder's own commit is one. */
  basis: PdfPageInfo[]
  /** Where among the pages that stay the block lands, or null while the
      pointer is away and every page stands where it was. */
  at: number | null
  /** The file the block joins, let go where it is: that of the page nearest
      the pointer. Undefined for a file carried whole, which keeps its own. */
  joins?: number
  moving: number[]
}

type PageThumbnailsProps = {
  /** A background tab's pages are laid out only once its tab is shown. */
  active: boolean
  /** An edit is under way, which a page's own controls would only be
      refused behind: they dim until it lands. */
  busy: boolean
  canPaste: boolean
  currentPage: CurrentPage
  /** Pages a cut is standing over: still in the document, empty for a copy. */
  cutPages: ReadonlySet<number>
  documentId: number
  onCopyPages: () => void
  onCutPages: () => void
  /** On a chosen page, the whole choice goes with it. */
  onDeletePage: (pageNumber: number) => void
  /** A page's own delete control: that page alone, chosen or not. */
  onDeleteOnePage: (pageNumber: number) => void
  /** Whether focus is in the column: the clipboard keys are its only then. */
  onFocusChange: (focused: boolean) => void
  /** The files whose pages are folded away under their names. */
  foldedFiles: ReadonlySet<number>
  onFoldFiles: (sections: readonly number[], folded: boolean) => void
  /** Whether each file of a document of several starts a row of its own. */
  fileRows: boolean
  onFileRowsChange: (fileRows: boolean) => void
  /** How the document's files are laid out and saved; absent with one file. */
  fileOptions: FileOptions | undefined
  onFileOptionsChange: (change: Partial<FileOptions>) => void
  /** The blank pages a Save As will add, shown where it will put them. */
  padding: readonly PaddingSheet[]
  /** The page a blank goes in front of, 1-based; one past the last appends.
      `section` is the file it joins, that of the page it was asked beside. */
  onInsertBlankPage: (index: number, section?: number) => void
  /** Copies another document's pages in before this 1-based page, into the
      file they were let go among. Null where the document cannot take them
      now; else settles on whether they landed. */
  onInsertCarriedPages: (
    carried: CarriedPages,
    index: number,
    section?: number,
  ) => Promise<boolean> | null
  /** A page edit in flight is about to renumber the pages a drag names. */
  isEditingNow: () => boolean
  /** A right-click, before its menu opens: a page outside the selection
      becomes the selection, so the menu means what is on screen. */
  onMenuPage: (pageNumber: number) => void
  /** A plain click on a page, or on a file's name, goes there. */
  onNavigate: (pageNumber: number) => void
  onPastePages: (index: number, section?: number) => void
  /** From a file's name: every page of the file, out of the document. */
  onRemoveFile: (section: number) => void
  onRenameFile: (section: number, title: string) => void
  /** Settles once the reorder has landed or been refused: the column holds
      the dropped order until then, rather than flash the old one. `moving`
      joins `section`, the file it was let go among. */
  onReorderPages: (order: number[], moving: number[], section?: number) => Promise<unknown>
  /** A page's own turn control: that page alone, chosen or not. */
  onRotatePage: (pageNumber: number, degrees: 90 | 270) => void
  onRotatePages: (degrees: 90 | 270) => void
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  /** A file's name pressed: its pages chosen as one. */
  onSelectPages: (pages: readonly number[], modifiers: SelectionModifiers) => void
  pages: PdfPageInfo[]
  /** The document's files; once more than one, their names head their pages. */
  sections: PdfSection[]
  /** Where a preview waits while an edit has its page out of the document. */
  parkedPreviews: ParkedPreviews
  renderEpochs: RenderEpochs
  selectedPages: ReadonlySet<number>
  /** Follow each page through a reorder, so its painted preview moves with it. */
  thumbnailKeys: number[]
  viewRotation: number
}

/** The document's pages in the sidebar, down one column or, widened, in rows
    of several: where the reader finds a page, and where pages are chosen,
    reordered, turned and removed, a file of several folded to its name. */
export const PageThumbnails = forwardRef<PageThumbnailsHandle, PageThumbnailsProps>(
  function PageThumbnails({
  active,
  busy,
  canPaste,
  currentPage,
  cutPages,
  documentId,
  onCopyPages,
  onCutPages,
  onDeletePage,
  onDeleteOnePage,
  isEditingNow,
  fileOptions,
  fileRows,
  foldedFiles,
  onFileOptionsChange,
  onFileRowsChange,
  onFocusChange,
  onFoldFiles,
  onInsertBlankPage,
  onInsertCarriedPages,
  onMenuPage,
  onNavigate,
  onPastePages,
  onRemoveFile,
  onRenameFile,
  onReorderPages,
  onRotatePage,
  onRotatePages,
  onSelectPage,
  onSelectPages,
  padding,
  pages,
  parkedPreviews,
  renderEpochs,
  sections,
  selectedPages,
  thumbnailKeys,
  viewRotation,
}, ref) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLOListElement>(null)
  const current = useCurrentPage(currentPage)
  const followedRef = useRef<number | null>(null)
  const [menu, setMenu] = useState<{
    pageNumber: number
    pages: PdfPageInfo[]
  } | null>(null)
  // A file's name has a menu of its own; `first` is the page its heading
  // stands over, which tells one run of a parted file from the other.
  const [fileMenu, setFileMenu] = useState<{
    first: number
    pages: PdfPageInfo[]
    section: number
  } | null>(null)
  // The heading whose name is being typed over, in place.
  const [renaming, setRenaming] = useState<{
    first: number
    pages: PdfPageInfo[]
    section: number
  } | null>(null)
  // An edit can land under the open menu and renumber the pages; the menu then
  // closes rather than act on whatever holds its number now.
  const menuPage = menu?.pages === pages ? menu.pageNumber : null
  const menuFile = fileMenu?.pages === pages ? fileMenu : null
  const renamed = renaming?.pages === pages ? renaming : null
  const [drag, setDrag] = useState<ColumnDrag | null>(null)
  // Thumbnail keys, not page numbers: a hole outlives the reorder's commit
  // until the ghost has settled into it.
  const [holes, setHoles] = useState(NO_HOLES)
  const [ghost, setGhost] = useState<PageDragGhostState | null>(null)
  const [landing, setLanding] = useState<{
    /** Where the ghost lands instead, outside this column; null fades it. */
    box?: { left: number; top: number } | null
    /** The flip key of the cell the ghost lands on: the pressed page's
        hole, or the bar of a folded file carried whole. */
    leadKey: string
    onLanded?: () => void
    settled: Promise<unknown>
  } | null>(null)
  const carry = usePageCarryContext()
  // The flip layout is told about the holes, and opens them: its `prime`
  // is reached through a ref the layout fills in below.
  const primeRef = useRef(() => {})
  const primeIncoming = useCallback(() => primeRef.current(), [])
  // The pages under each folded file's bar, by the bar's flip key: what the
  // flow's cells stand for, as last rendered.
  const barsRef = useRef<ReadonlyMap<string, readonly number[]>>(new Map())
  // The flow's cells as laid out now, each with the pages it stands for that
  // are not in hand; a bar left none is in hand itself.
  const measure = useCallback(
    (moving: (key: string) => boolean, held: ReadonlySet<number> = NO_PAGES) => {
      const column = columnRef.current

      return column
        ? flowCells(column, moving).map((cell): WeighedFlowCell => {
            const run = barsRef.current.get(cell.key)

            if (!run) {
              return { ...cell, pages: 1 }
            }

            const staying = run.reduce(
              (count, pageNumber) => count + (held.has(pageNumber) ? 0 : 1),
              0,
            )

            return { ...cell, moving: staying === 0, pages: staying }
          })
        : []
    },
    [],
  )

  // Where files held over the pages would land, worked out once per move of
  // the point so that the marker, the blanks they would bring and the drop
  // agree. Over no page the last landing holds: in rows, a blank shown for
  // it may stand where the page under the point was.
  const fileDrop = useSidebarDrop()
  const [fileLanding, setFileLanding] = useState<{ at: number; slot: number } | null>(null)
  const fileLandingRef = useRef(fileLanding)
  const landFiles = useCallback(
    (point: { x: number; y: number } | null) => {
      const column = columnRef.current

      if (!column) {
        return null
      }

      const cells = measure(() => false)
      const slot =
        (point &&
          flowLanding(pointInColumn(column, point), cells, fileLandingRef.current?.slot ?? null)) ??
        cells.length

      return { at: pagesBeforeSlot(cells, slot), slot }
    },
    [measure],
  )

  // The blanks a landing shows move the pages under a still point: it is
  // worked out again as they settle, twice at most per report of the point.
  const fileReflowsRef = useRef(0)
  const placeFiles = useCallback(() => {
    const next = landFiles(sidebarDropPoint())
    const last = fileLandingRef.current

    if (next?.at !== last?.at || next?.slot !== last?.slot) {
      fileLandingRef.current = next
      setFileLanding(next)
    }
  }, [landFiles])

  useDropEdgeScroll(listRef, active)

  useEffect(() => {
    if (fileDrop !== "over" || !active) {
      fileLandingRef.current = null
      setFileLanding(null)
      return
    }

    const moved = () => {
      fileReflowsRef.current = 0
      placeFiles()
    }

    moved()

    return subscribeSidebarDropPoint(moved)
  }, [active, fileDrop, placeFiles])

  useLayoutEffect(() => {
    if (fileLanding && fileReflowsRef.current < 2) {
      fileReflowsRef.current += 1
      placeFiles()
    }
  }, [fileLanding, placeFiles])
  // The file of the cell a drop lands nearest, other than those in hand: a
  // drop between two files' pages joins the one it was let go beside, and one
  // on a folded file's name joins that file.
  const sectionNear = useCallback((point: { x: number; y: number }, cells: WeighedFlowCell[]) => {
    const column = columnRef.current

    // Read at every move of a drag: a document of one file has none to join.
    if (!severalFilesRef.current || !column) {
      return undefined
    }

    const staying = cells.filter((cell) => !cell.moving)
    const nearest = staying[nearestBox(pointInColumn(column, point), staying)]

    if (!nearest) {
      return undefined
    }

    if (nearest.bar) {
      return Number(nearest.element.dataset.sectionHeader)
    }

    const paper = nearest.element.querySelector<HTMLElement>("[data-thumbnail-page]")

    return paper ? pagesRef.current[Number(paper.dataset.thumbnailPage) - 1]?.section : undefined
  }, [])
  const incoming = useIncomingPages({
    cells: measure,
    columnRef,
    documentId,
    joinsAt: sectionNear,
    onInsert: onInsertCarriedPages,
    pages,
    prime: primeIncoming,
    viewRef: listRef,
  })
  const ghostRef = useRef<PageDragGhostHandle>(null)
  // From a release until the column is its own again, a press is no drag.
  const settlingRef = useRef(false)
  const draggedAtRef = useRef(0)
  const selectionRef = useRef(selectedPages)
  const pagesRef = useRef(pages)
  const severalFilesRef = useRef(sections.length > 1)
  const keysRef = useRef(thumbnailKeys)
  const isEditingRef = useRef(isEditingNow)
  // A column gone before its ghost is down still lets the taker's holes close.
  const pendingLandedRef = useRef<(() => void) | undefined>(undefined)
  const [columns, setColumns] = useState(1)
  // The columns last measured, a render ahead of the ones laid out: the
  // reader's page is looked for only once the pages stand in them.
  const fittedColumnsRef = useRef(columns)
  const grid = columns > 1
  const numPages = pages.length
  const { prime } = useFlipLayout(
    columnRef,
    drag !== null || ghost !== null || incoming !== null,
    thumbnailKeys,
  )
  primeRef.current = prime
  const order =
    drag?.basis === pages && drag.at !== null
      ? orderWithBlockAt(drag.moving, drag.at, numPages)
      : pages.map((_, index) => index + 1)
  const incomingAt =
    incoming?.basis === pages && incoming.at !== null ? incoming.at : null
  // The copies have arrived ahead of the ghost: they wait as its holes.
  const arrived =
    incoming?.landing && !incoming.ghostDown && incoming.basis !== pages && incoming.at !== null
      ? new Set(
          thumbnailKeys.slice(incoming.at, incoming.at + incoming.carried.pages.length),
        )
      : NO_HOLES

  selectionRef.current = selectedPages
  pagesRef.current = pages
  severalFilesRef.current = sections.length > 1
  keysRef.current = thumbnailKeys
  isEditingRef.current = isEditingNow

  useImperativeHandle(
    ref,
    () => ({
      // Where the marker stands, once one shows: the drop's own point is the
      // last the drag reported.
      fileDropSlot: (point) => (fileLandingRef.current ?? landFiles(point))?.at ?? null,
    }),
    [landFiles],
  )

  // As many columns as the sidebar's width holds, the reader's to widen.
  useLayoutEffect(() => {
    const list = listRef.current

    if (!list) {
      return
    }

    const fit = (width: number) => {
      // A background tab's column has no box; it keeps the columns it had.
      if (width > 0) {
        fittedColumnsRef.current = thumbnailColumns(width, THUMBNAIL_WIDTH)
        setColumns(fittedColumnsRef.current)
      }
    }
    const observer = new ResizeObserver(([entry]) => fit(entry?.contentRect.width ?? 0))
    const style = getComputedStyle(list)

    // Before the paint too, at first and again as the tab comes to show: the
    // observer's report lands a frame late, which would show a wide sidebar
    // as one column first, or as the columns it had before it was widened.
    fit(list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    observer.observe(list)

    return () => observer.disconnect()
  }, [active])

  // One page's own controls act on that page alone. Read through a ref, so the
  // memoised previews keep one handler across the session's every render.
  const actionsRef = useRef({ onDeleteOnePage, onInsertBlankPage, onRotatePage, onSelectPage })

  actionsRef.current = { onDeleteOnePage, onInsertBlankPage, onRotatePage, onSelectPage }

  // A control that leaves with what it acted on fires no blur as it goes: the
  // column takes the focus first, and with it keeps the page keys. A click
  // focuses the control too, except in WebKit on macOS.
  const keepFocus = useCallback(() => {
    if (listRef.current?.contains(document.activeElement)) {
      listRef.current.focus({ preventScroll: true })
    }
  }, [])

  const act = useCallback<PageActionHandler>((pageNumber, action) => {
    const actions = actionsRef.current

    switch (action) {
      case "toggle":
        actions.onSelectPage(pageNumber, { range: false, toggle: true })
        break
      case "rotate-left":
        actions.onRotatePage(pageNumber, 270)
        break
      case "rotate-right":
        actions.onRotatePage(pageNumber, 90)
        break
      case "delete":
        keepFocus()
        actions.onDeleteOnePage(pageNumber)
        break
    }
  }, [keepFocus])

  // Before the page, the file it joins is that page's; after the last, the
  // last page's.
  const insertBlank = useCallback((pageNumber: number, side: "before" | "after") => {
    actionsRef.current.onInsertBlankPage(
      side === "before" ? pageNumber : pageNumber + 1,
      pagesRef.current[pageNumber - 1]?.section,
    )
  }, [])

  // A column unmounted with focus in it (an overlay dismissed, the sidebar
  // hidden) fires no blur, which would leave the clipboard keys on the pages.
  useEffect(() => () => onFocusChange(false), [onFocusChange])

  useEffect(() => () => pendingLandedRef.current?.(), [])

  // Only when the reader's page changes, never on every render: a reader
  // scrolling the column to look further ahead must not be pulled back.
  useLayoutEffect(() => {
    const list = listRef.current
    // Folded away, the page is where its file's name stands.
    const bar = [...barsRef.current].find(([, run]) => run.includes(current))?.[0]
    const paper = list?.querySelector<HTMLElement>(
      bar === undefined ? `[data-thumbnail-page="${current}"]` : `[data-flip-key="${bar}"]`,
    )

    if (
      !active ||
      !list ||
      !paper ||
      followedRef.current === current ||
      // The columns just measured are a render away: a place found among
      // these would be wrong once the pages stand in rows.
      fittedColumnsRef.current !== columns ||
      list.getClientRects().length === 0
    ) {
      return
    }

    // Measured against the column itself: `scrollIntoView` would also scroll
    // the clipped panels the column sits in.
    const listBox = list.getBoundingClientRect()
    const paperBox = paper.getBoundingClientRect()
    const margin = 12
    const instant = followedRef.current === null

    followedRef.current = current

    if (paperBox.top < listBox.top + margin) {
      list.scrollBy({
        behavior: instant ? "instant" : "smooth",
        top: paperBox.top - listBox.top - margin,
      })
    } else if (paperBox.bottom > listBox.bottom - margin) {
      list.scrollBy({
        behavior: instant ? "instant" : "smooth",
        top: paperBox.bottom - listBox.bottom + margin,
      })
    }
  }, [active, columns, current])

  // After the release's render, so the hole is where the pages now stand.
  useLayoutEffect(() => {
    const column = columnRef.current

    if (!landing || !column) {
      return
    }

    const box =
      landing.box !== undefined
        ? landing.box
        : landingBox(
            column,
            column.querySelector(`[data-flip-key="${landing.leadKey}"]`),
            LANDING_PAPER,
            listRef.current,
          )
    pendingLandedRef.current = landing.onLanded
    // A landing that fails still lets the pages back out of their holes.
    void Promise.resolve(ghostRef.current?.land(box))
      .catch(() => {})
      .then(() => {
        setHoles(NO_HOLES)
        setGhost(null)
        pendingLandedRef.current = undefined
        landing.onLanded?.()

        return landing.settled
      })
      .catch(() => {})
      .then(() => {
        settlingRef.current = false
        setDrag(null)
        setLanding(null)
      })
  }, [landing])

  // A plain click both chooses the page and goes to it; Ctrl or Shift only
  // add to the choice, leaving the reader where they are.
  const select = useCallback(
    (pageNumber: number, modifiers: SelectionModifiers) => {
      if (performance.now() - draggedAtRef.current < DRAG_CLICK_GRACE_MS) {
        return
      }

      onSelectPage(pageNumber, modifiers)

      if (!modifiers.range && !modifiers.toggle) {
        onNavigate(pageNumber)
      }
    },
    [onNavigate, onSelectPage],
  )

  // A file's name chooses its every page, and goes to the first under it.
  const selectFile = (
    section: number,
    first: number,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    if (performance.now() - draggedAtRef.current < DRAG_CLICK_GRACE_MS) {
      return
    }

    const modifiers = { range: event.shiftKey, toggle: event.ctrlKey || event.metaKey }

    onSelectPages(pagesOfSection(pagesRef.current, section), modifiers)

    if (!modifiers.range && !modifiers.toggle) {
      onNavigate(first)
    }
  }

  const startDrag = (event: ReactPointerEvent) => {
    const target = event.target as Element
    // A file's name carries the whole file, lifted by the first page under
    // it, or by the name itself once its pages are folded away.
    const heading = target.closest<HTMLElement>("[data-section-header]")
    const wholeFile = heading ? Number(heading.dataset.sectionHeader) : undefined
    const foldedFile = heading?.dataset.flipBar !== undefined
    const paper = heading
      ? foldedFile
        ? heading.querySelector<HTMLElement>(FILE_HEADING_NAME)
        : heading.nextElementSibling?.querySelector<HTMLElement>("[data-thumbnail-page]")
      : target.closest<HTMLElement>("[data-thumbnail-page]")
    const list = listRef.current
    const column = columnRef.current

    if (
      event.button !== 0 ||
      // Its arrow folds the file and carries nothing.
      target.closest("[data-fold-toggle]") ||
      !paper ||
      !list ||
      !column ||
      settlingRef.current ||
      // A press while a name is typed places the caret, or ends the edit by
      // leaving the field: the rename it settles is about to replace the
      // pages a drag begun on the same press would be measured against.
      renamed !== null
    ) {
      return
    }

    const pressed = foldedFile
      ? Number(heading!.dataset.runFirst)
      : Number(paper.dataset.thumbnailPage)
    const basis = pagesRef.current
    const keys = keysRef.current
    const keyOf = (pageNumber: number) => keys[pageNumber - 1] ?? pageNumber - 1
    const start = { x: event.clientX, y: event.clientY }
    let moving: number[] | null = null
    let held: ReadonlySet<number> = NO_PAGES
    let movingKeys: ReadonlySet<string> = new Set()
    let leadKey = ""
    // Where the ghost goes back to when nothing moves: a folded file parted
    // in two stands as two bars again, and it was lifted by one of them.
    let homeKey = ""
    let carried: CarriedPages | null = null
    // Out over the tab strip or another tab's column, where the window answers.
    let carrying = false
    let at: number | null = null
    // `at` as the flow counts it, by cells: a folded file is one, of many
    // pages. What the next landing is read against.
    let slot: number | null = null
    let joins: number | undefined
    let point = start
    // Where the landing was last read: the blanks it shows can move the rows
    // under a still pointer, and a release there keeps what is on screen.
    let targeted: { x: number; y: number } | null = null
    let frame = 0

    // Hidden once the drag has opened another tab: its box is then all zeros.
    const beside = () =>
      list.getClientRects().length > 0 &&
      besideColumn(point.x, list.getBoundingClientRect())
    // Read from the column as laid out now — the block where it last landed —
    // and by key, so a preview not yet rendered still reads right.
    const retarget = () => {
      if (!moving) {
        return
      }

      targeted = point

      // The strip runs past the column's edge, and is the way to other tabs.
      const home = beside() && !stripSpotAt(point)

      if (!home && carry && carried) {
        carrying = true
        carry.move(carried, point)
      } else if (carrying) {
        carrying = false
        carry?.cancel()
      }

      // Cells only: a page leaving fades among them, keyless.
      const cells =
        home && pagesRef.current === basis ? measure((key) => movingKeys.has(key), held) : null

      slot = cells ? flowLanding(pointInColumn(column, point), cells, slot) : null

      const next = cells && slot !== null ? pagesBeforeSlot(cells, slot) : null
      // Read off the cells as a release reads them, so the blanks shown in
      // the meantime are the ones the drop lays out.
      const nextJoins =
        cells && next !== null && wholeFile === undefined ? sectionNear(point, cells) : undefined

      if (next !== at || nextJoins !== joins) {
        at = next
        joins = nextJoins
        setDrag({ at, basis, joins, moving })
      }
    }
    const edgeScroll = () => {
      const step =
        carrying || list.getClientRects().length === 0
          ? 0
          : columnEdgeStep(point, list.getBoundingClientRect())

      if (step !== 0) {
        list.scrollBy({ top: step })
        retarget()
      }

      frame = requestAnimationFrame(edgeScroll)
    }
    const move = (moved: PointerEvent) => {
      point = { x: moved.clientX, y: moved.clientY }

      if (!moving) {
        if (!exceedsDragThreshold(start, point)) {
          return
        }

        const chosen = wholeFile === undefined && selectionRef.current.has(pressed)

        moving =
          wholeFile !== undefined
            ? pagesOfSection(basis, wholeFile)
            : chosen
              ? [...selectionRef.current].sort((left, right) => left - right)
              : [pressed]
        held = new Set(moving)
        movingKeys = new Set(moving.map((pageNumber) => String(keyOf(pageNumber))))
        homeKey = foldedFile ? foldedBarKey(keyOf(pressed)) : String(keyOf(pressed))
        // A folded file lands as its bar, which goes by its first page.
        leadKey = foldedFile ? foldedBarKey(keyOf(moving[0]!)) : homeKey
        carried = {
          lead: moving.indexOf(pressed),
          pages: moving,
          sizes: moving.map((pageNumber) => {
            const { height, width } = basis[pageNumber - 1]!

            return { height, width }
          }),
          sourceDocumentId: documentId,
        }
        // The block gathers where the pressed page stands.
        at = pressed - 1 - moving.filter((pageNumber) => pageNumber < pressed).length
        slot = slotOfPages(measure((key) => movingKeys.has(key), held), at)

        if (wholeFile !== undefined) {
          onSelectPages(moving, { range: false, toggle: false })
        } else if (!chosen) {
          onSelectPage(pressed, { range: false, toggle: false })
        }

        prime()
        setHoles(new Set(moving.map(keyOf)))
        setDrag({ at, basis, moving })
        setGhost(
          liftGhost(
            paper,
            moving.length,
            start,
            point,
            foldedFile ? (paper.textContent ?? undefined) : undefined,
          ),
        )
        frame = requestAnimationFrame(edgeScroll)
      }

      ghostRef.current?.moveTo(point)
      retarget()
    }
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", release)
      document.removeEventListener("pointercancel", cancel)
      document.removeEventListener("keydown", escape, true)

      if (!moving) {
        return
      }

      draggedAtRef.current = performance.now()

      if (commit && (targeted?.x !== point.x || targeted.y !== point.y)) {
        retarget()
      }

      if (carrying) {
        // The pages are copied, never taken: this column puts its own back.
        const taken: CarryLanding | null =
          commit &&
          carried &&
          pagesRef.current === basis &&
          !isEditingRef.current()
            ? (carry?.drop(carried, point) ?? null)
            : null

        if (!taken) {
          carry?.cancel()
        }

        at = null
        slot = null
        settlingRef.current = true
        setDrag({ at, basis, moving })
        setLanding({
          box: taken ? taken.box : undefined,
          leadKey: homeKey,
          onLanded: taken?.landed,
          settled: taken?.settled ?? Promise.resolve(),
        })
        return
      }

      const reorder =
        commit && at !== null && pagesRef.current === basis
          ? orderWithBlockAt(moving, at, basis.length)
          : null
      const moved = reorder?.some((pageNumber, index) => pageNumber !== index + 1) ?? false
      // A whole file stays its own file wherever it lands; pages join the file
      // the release's own retarget found them beside.
      const nearest = reorder ? joins : undefined
      // Let go where they stand but beside the next file's first page, they
      // join it — unless that would leave their own file with no page at all:
      // a one-page file's page let go in place stays its file's.
      const section = !moved && emptiesItsFile(basis, moving) ? undefined : nearest
      const regrouped =
        section !== undefined &&
        moving.some((pageNumber) => basis[pageNumber - 1]?.section !== section)
      const changes = moved || (reorder !== null && regrouped)

      // Otherwise the pages go back where they were and the ghost with them.
      if (!changes) {
        at = null
        slot = null
      }

      settlingRef.current = true
      setDrag({ at, basis, joins: section, moving })
      setLanding({
        leadKey: changes ? leadKey : homeKey,
        settled: changes ? onReorderPages(reorder!, moving, section) : Promise.resolve(),
      })
    }
    const release = (released: PointerEvent) => {
      point = { x: released.clientX, y: released.clientY }
      finish(true)
    }
    const cancel = () => finish(false)
    const escape = (pressedKey: KeyboardEvent) => {
      // A press not yet a drag leaves Esc to its usual owners.
      if (pressedKey.key === "Escape" && moving) {
        // Ahead of the selection's, the clipboard's and the overlay's own Esc:
        // this one ends the drag and nothing else.
        pressedKey.preventDefault()
        pressedKey.stopPropagation()
        finish(false)
      }
    }

    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", release)
    document.addEventListener("pointercancel", cancel)
    document.addEventListener("keydown", escape, true)
  }

  // The page pressed alone only until its click's selection lands. Blanks and
  // pastes go before the first or after the last.
  // Folded, not spread: a select-all can pass the engine's argument limit.
  const menuPages: Iterable<number> =
    menuPage === null ? [] : selectedPages.has(menuPage) ? selectedPages : [menuPage]
  let menuCount = 0
  let menuFirst = Number.POSITIVE_INFINITY
  let menuLast = Number.NEGATIVE_INFINITY

  for (const pageNumber of menuPages) {
    menuCount += 1
    menuFirst = Math.min(menuFirst, pageNumber)
    menuLast = Math.max(menuLast, pageNumber)
  }

  // Each file's name heads its first page, once the document has several and
  // the reader keeps them apart; pages in hand stand among others for now.
  const byFile = fileRows && sections.length > 1
  const titles = new Map(sections.map((section) => [section.id, section.title]))
  const moving = new Set(drag?.basis === pages ? drag.moving : [])
  const { blanks, blankAfterCarried } = previewBlanks({
    drag: drag?.basis === pages && drag.at !== null ? drag : null,
    incoming:
      incomingAt !== null && incoming
        ? { at: incomingAt, joins: incoming.joins, sizes: incoming.carried.sizes }
        : null,
    files: fileLanding
      ? {
          at: fileLanding.at,
          // As the add will lay them out: by the document's choice once it
          // has files, by the reader's last otherwise.
          smartPadding: fileOptions?.smartPadding ?? storedFileOptions().smartPadding,
        }
      : null,
    order,
    padding,
    pages,
    smartPadding: fileOptions?.smartPadding === true,
  })
  const items = flowItems({
    breakAt: incomingAt,
    byFile,
    folded: foldedFiles,
    held: moving,
    order,
    pages,
  })
  const keyOf = (pageNumber: number) => thumbnailKeys[pageNumber - 1] ?? pageNumber - 1
  const bars = new Map<string, readonly number[]>()

  for (const item of items) {
    if (item.kind === "bar") {
      bars.set(foldedBarKey(keyOf(item.pages[0]!)), item.pages)
    }
  }

  barsRef.current = bars

  const foldedCount = byFile
    ? sections.reduce((count, section) => count + (foldedFiles.has(section.id) ? 1 : 0), 0)
    : 0
  // The way out stands on the blank itself: the option that puts it there is
  // a menu away, under a name the reader has yet to connect with this page.
  const dismissPadding = () => {
    keepFocus()
    onFileOptionsChange({ smartPadding: false })
  }
  const fileHeading = (section: number, first: number, run?: readonly number[]) => {
    const isRenamed = renamed?.section === section && renamed.first === first

    return (
      <FileHeading
        count={run?.length ?? 0}
        current={run?.includes(current) === true}
        flipKey={foldedBarKey(keyOf(first))}
        folded={run !== undefined}
        // In hand whole: pages let go into a folded file leave its name up.
        hole={run?.every((pageNumber) => holes.has(keyOf(pageNumber))) === true}
        // One key folded or not, so the arrow pressed keeps the focus.
        key={`heading-${keyOf(first)}`}
        onFold={(folded) => onFoldFiles([section], folded)}
        onRename={() => setRenaming({ first, pages, section })}
        onRenameDone={(title) => {
          // Enter and Esc take the field away with the caret still in it.
          keepFocus()
          setRenaming(null)

          if (title !== null) {
            onRenameFile(section, title)
          }
        }}
        onSelect={(event) => selectFile(section, first, event)}
        renaming={isRenamed}
        runFirst={first}
        section={section}
        selected={run?.every((pageNumber) => selectedPages.has(pageNumber)) === true}
        title={titles.get(section) ?? ""}
      />
    )
  }

  return (
    <div
      className="flex h-full flex-col"
      data-pages-busy={busy ? "" : undefined}
      // Pages under a stack in hand, these or another tab's, show none of
      // their controls.
      data-pages-dragging={drag !== null || ghost !== null || incoming !== null ? "" : undefined}
      data-pages-surface
    >
      <PagesBar
        fileOptions={fileOptions}
        fileRows={fileRows}
        folded={{ count: foldedCount, of: sections.length }}
        onFileOptionsChange={onFileOptionsChange}
        onFileRowsChange={onFileRowsChange}
        onFoldAll={(folded) =>
          onFoldFiles(
            sections.map((section) => section.id),
            folded,
          )
        }
        severalFiles={sections.length > 1}
      />
      <div className="relative min-h-0 flex-1" data-sidebar-drop-list>
        <ContextMenu
          onOpenChange={(open) => {
            if (!open) {
              setMenu(null)
              setFileMenu(null)
            }
          }}
          // Off while a file's name is typed: the field keeps the WebView's
          // own cut, copy and paste menu.
          disabled={renamed !== null}
          // Opened by a press on a page or a file's name alone: elsewhere in
          // the column there is nothing for the entries to act on.
          open={menuPage !== null || menuFile !== null}
        >
          <ContextMenuTrigger
            render={
              <div
                aria-label={t("sidebar.thumbnails")}
                // Room at the sides for the first of a row's way in to a
                // blank, which stands in the gap before its page.
                className="overlay-scroll-viewport h-full overflow-y-auto overscroll-contain px-6 pt-5 pb-8 outline-none select-none"
                data-slot="sidebar-thumbnails"
                data-thumbnail-scroll-root
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    onFocusChange(false)
                  }
                }}
                onContextMenu={(event) => {
                  // A name being typed keeps the WebView's own cut, copy and
                  // paste menu; the pages wait for the name to be settled.
                  if (renamed) {
                    if (!isTypingTarget(event.target)) {
                      event.preventDefault()
                    }

                    return
                  }

                  const heading = (event.target as Element).closest<HTMLElement>(
                    "[data-section-header]",
                  )

                  if (heading) {
                    setMenu(null)
                    setFileMenu({
                      first: Number(heading.dataset.runFirst),
                      pages,
                      section: Number(heading.dataset.sectionHeader),
                    })
                    return
                  }

                  // A press on a page's own controls means that page too.
                  const paper = (event.target as Element)
                    .closest("[data-flip-key]")
                    ?.querySelector<HTMLElement>("[data-thumbnail-page]")

                  // Only a page has a menu; elsewhere the WebView's own stays away.
                  if (!paper) {
                    event.preventDefault()
                    return
                  }

                  const pageNumber = Number(paper.dataset.thumbnailPage)

                  onMenuPage(pageNumber)
                  setFileMenu(null)
                  setMenu({ pageNumber, pages })
                }}
                onFocus={() => onFocusChange(true)}
                onKeyDown={(event) => {
                  // A file's name typed in place: Backspace is its own.
                  if (isTypingTarget(event.target)) {
                    return
                  }

                  const first = Math.min(...selectionRef.current)

                  if (
                    (event.key === "Delete" || event.key === "Backspace") &&
                    Number.isFinite(first)
                  ) {
                    event.preventDefault()
                    // A focused preview leaves with its page, and a removed
                    // element fires no blur: the column keeps the focus instead.
                    event.currentTarget.focus({ preventScroll: true })
                    onDeletePage(first)
                  }
                }}
                onPointerDown={startDrag}
                ref={listRef}
                role="navigation"
                // WebKit on macOS never focuses a clicked button; the column takes
                // the focus instead, so the page keys still reach it.
                tabIndex={-1}
              />
            }
          >
            {/* Positioned: the slides read each cell's place off it. As wide as
                its columns, so a short last row starts at the left. */}
            <ol
              className={cn(
                "relative flex",
                grid ? "mx-auto flex-wrap" : "flex-col items-center",
              )}
              data-thumbnail-columns={columns}
              ref={columnRef}
              style={
                grid
                  ? {
                      columnGap: THUMBNAIL_GRID_GAP,
                      rowGap: THUMBNAIL_GRID_GAP,
                      width: columns * THUMBNAIL_WIDTH + (columns - 1) * THUMBNAIL_GRID_GAP,
                    }
                  : { rowGap: THUMBNAIL_COLUMN_GAP }
              }
            >
              {/* Flat, so each preview keeps its key among the column's rows. */}
              {[...items, null].flatMap((item) => {
                const index = item?.index ?? order.length
                const holesHere =
                  index === incomingAt ? (
                    <CarriedHoles
                      carryKey={CARRY_KEY}
                      key={CARRY_KEY}
                      rotation={viewRotation}
                      sizes={incoming!.carried.sizes}
                    />
                  ) : null
                const blankAfterHoles =
                  index === incomingAt && blankAfterCarried ? (
                    <PaddingCell
                      key={`padding-${CARRY_KEY}`}
                      label={t("sidebar.paddingPage")}
                      onDismiss={dismissPadding}
                      rotation={viewRotation}
                      sheet={blankAfterCarried}
                    />
                  ) : null

                if (item === null) {
                  return [holesHere, blankAfterHoles]
                }

                // A folded file's pages, and the blanks among them, stand
                // under its name alone.
                if (item.kind === "bar") {
                  return [
                    holesHere,
                    blankAfterHoles,
                    fileHeading(item.section, item.pages[0]!, item.pages),
                  ]
                }

                const { pageNumber } = item
                const page = pages[pageNumber - 1]!
                const key = keyOf(pageNumber)
                const carriedAhead =
                  incomingAt !== null && index >= incomingAt ? incoming!.carried.pages.length : 0

                return [
                  holesHere,
                  blankAfterHoles,
                  item.heads === undefined ? null : fileHeading(item.heads, pageNumber),
                  <PageCell
                    // Where the page stands in a drag's preview, as it will once
                    // the pages land.
                    caption={index + 1 + carriedAhead}
                    // A document keeps one page; the backend refuses a delete of them all.
                    deleteDisabled={numPages <= 1}
                    documentId={documentId}
                    flipKey={key}
                    grid={grid}
                    hole={holes.has(key) || arrived.has(key)}
                    intrinsicRotation={page.rotation}
                    isCurrent={current === pageNumber}
                    isCut={cutPages.has(pageNumber)}
                    isLast={pageNumber === numPages}
                    isSelected={selectedPages.has(pageNumber)}
                    key={key}
                    label={t("sidebar.thumbnailLabel", { pageNumber })}
                    onAction={act}
                    onInsertBlank={insertBlank}
                    onSelect={select}
                    pageHeight={page.height}
                    pageNumber={pageNumber}
                    pageWidth={page.width}
                    parked={parkedPreviews}
                    renderEpoch={renderEpochs[pageNumber] ?? 0}
                    rotation={viewRotation}
                    signed={page.signed === true}
                  />,
                  blanks.has(pageNumber) ? (
                    <PaddingCell
                      key={`padding-${key}`}
                      label={t("sidebar.paddingPage")}
                      onDismiss={dismissPadding}
                      rotation={viewRotation}
                      sheet={blanks.get(pageNumber)!}
                    />
                  ) : null,
                ]
              })}
            </ol>
          </ContextMenuTrigger>
          {menuPage !== null ? (
            <PageMenuContent
              canPaste={canPaste}
              count={menuCount}
              // A document keeps one page; the backend refuses a delete of them all.
              deleteDisabled={menuCount >= numPages}
              onCopy={onCopyPages}
              onCut={onCutPages}
              onDelete={() => onDeletePage(menuPage)}
              onInsertBlank={(side) =>
                onInsertBlankPage(
                  side === "before" ? menuFirst : menuLast + 1,
                  pages[(side === "before" ? menuFirst : menuLast) - 1]?.section,
                )
              }
              onPaste={(side) =>
                onPastePages(
                  side === "before" ? menuFirst : menuLast + 1,
                  pages[(side === "before" ? menuFirst : menuLast) - 1]?.section,
                )
              }
              onRotate={onRotatePages}
            />
          ) : menuFile !== null ? (
            <FileMenuContent
              canPaste={canPaste}
              onPaste={(end) => {
                // The run under the heading pressed, not the file's every page.
                const run = fileRuns(pages).find((each) => each.first === menuFile.first)

                if (run) {
                  onPastePages(
                    end === "start" ? run.first : run.first + run.count,
                    menuFile.section,
                  )
                }
              }}
              onRemove={() => onRemoveFile(menuFile.section)}
              onRename={() => setRenaming(menuFile)}
              onSelect={() =>
                onSelectPages(pagesOfSection(pages, menuFile.section), {
                  range: false,
                  toggle: false,
                })
              }
              // A document keeps a page; the last file's go no further.
              removeDisabled={pagesOfSection(pages, menuFile.section).length >= numPages}
            />
          ) : null}
          {ghost ? (
            <PageDragGhost
              count={ghost.count}
              grip={ghost.grip}
              key={ghost.id}
              paper={ghost.paper}
              point={ghost.point}
              ref={ghostRef}
            />
          ) : null}
        </ContextMenu>
        <OverlayScrollbars viewportRef={listRef} />
        <PagesDropTarget
          flowRef={columnRef}
          grid={grid}
          slot={fileLanding?.slot ?? null}
        />
      </div>
    </div>
  )
})

/**
 * The blank pages a Save As will add, by the page each follows: the engine's
 * own while the pages stand still, and while some are in hand, where a drop
 * there would leave them — laid out by the engine's rule over the order shown.
 * Pages another tab is carrying in are no pages yet: a blank after them is
 * said apart.
 */
function previewBlanks({
  drag,
  files,
  incoming,
  order,
  padding,
  pages,
  smartPadding,
}: {
  drag: ColumnDrag | null
  /** Files held over the pages, which would land after page `at`. */
  files: { at: number; smartPadding: boolean } | null
  incoming: { at: number; joins?: number; sizes: CarriedPages["sizes"] } | null
  order: number[]
  padding: readonly PaddingSheet[]
  pages: PdfPageInfo[]
  smartPadding: boolean
}): { blankAfterCarried: PaddingSheet | null; blanks: Map<number, PaddingSheet> } {
  const sheetAfter = (pageNumber: number): [number, PaddingSheet] => {
    const { height, width } = pages[pageNumber - 1]!

    return [pageNumber, { after: pageNumber, height, width }]
  }

  if (drag) {
    const moved = order.some((pageNumber, index) => pageNumber !== index + 1)
    // As the release decides it: in place, a file's last pages keep their file.
    const joins = !moved && emptiesItsFile(pages, drag.moving) ? undefined : drag.joins
    const held = new Set(drag.moving)
    const files = order.map((pageNumber) =>
      joins !== undefined && held.has(pageNumber) ? joins : pages[pageNumber - 1]!.section,
    )

    return {
      blankAfterCarried: null,
      blanks: new Map(
        smartPadding ? paddingPositions(files).map((index) => sheetAfter(order[index]!)) : [],
      ),
    }
  }

  if (incoming) {
    const carried = incoming.sizes.length
    const files = [
      ...pages.slice(0, incoming.at).map((page) => page.section),
      ...incoming.sizes.map(() => incoming.joins),
      ...pages.slice(incoming.at).map((page) => page.section),
    ]
    const blanks = new Map<number, PaddingSheet>()
    let blankAfterCarried: PaddingSheet | null = null

    for (const index of smartPadding ? paddingPositions(files) : []) {
      if (index < incoming.at) {
        blanks.set(...sheetAfter(index + 1))
      } else if (index >= incoming.at + carried) {
        blanks.set(...sheetAfter(index - carried + 1))
      } else {
        // The block is one file's throughout: only its last page can close it.
        const { height, width } = incoming.sizes[carried - 1]!

        blankAfterCarried = { after: incoming.at, height, width }
      }
    }

    return { blankAfterCarried, blanks }
  }

  if (files) {
    const sections = pages.map((page) => page.section)

    return {
      blankAfterCarried: null,
      blanks: new Map(
        files.smartPadding
          ? paddingAroundDropped(sections, files.at).map((index) => sheetAfter(index + 1))
          : [],
      ),
    }
  }

  return {
    blankAfterCarried: null,
    blanks: new Map(padding.map((sheet) => [sheet.after, sheet] as const)),
  }
}
