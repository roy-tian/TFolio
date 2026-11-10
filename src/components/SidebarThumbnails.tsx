import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { BetweenHorizontalStart, Bookmark, FilePlus2, Rows3 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { PageControls, type PageActionHandler } from "@/components/PageCardControls"
import {
  DragHole,
  landingBox,
  liftGhost,
  PageDragGhost,
  type PageDragGhostHandle,
  type PageDragGhostState,
} from "@/components/PageDragGhost"
import { PageMenuContent } from "@/components/PageContextMenu"
import { PageSignatureMark } from "@/components/SignatureBadge"
import { HintTooltip } from "@/components/HintTooltip"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"
import { useFlipLayout } from "@/hooks/useFlipLayout"
import { useNearViewport } from "@/hooks/useNearViewport"
import { CARRY_KEY, useIncomingPages } from "@/hooks/useIncomingPages"
import { usePageCarryContext, type CarryLanding } from "@/hooks/usePageCarry"
import { usePagesDrop } from "@/hooks/usePagesDrop"
import type { RenderEpochs } from "@/lib/annotations"
import { stripSpotAt, type CarriedPages } from "@/lib/pageCarry"
import {
  besideColumn,
  columnEdgeStep,
  exceedsDragThreshold,
  flowCells,
  flowLanding,
  nearestBox,
  orderWithBlockAt,
  pointInColumn,
} from "@/lib/pageDrag"
import type { ParkedPreviews } from "@/lib/parkedPreviews"
import type { PaddingSheet } from "@/lib/padding"
import {
  dimensionsForRotation,
  type FileOptions,
  type PdfPageInfo,
  type PdfSection,
} from "@/lib/pdf"
import { THUMBNAIL_GRID_GAP, thumbnailColumns } from "@/lib/sidebar"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, THUMBNAIL_WIDTH, thumbnailPaper } from "@/lib/viewMode"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"
// The click a drag ends on belongs to the drag; one later than this is a choice.
const DRAG_CLICK_GRACE_MS = 300
const NO_HOLES: ReadonlySet<number> = new Set()

/** Square cells as wide as a paper's long side, once a widened sidebar fits two:
    portrait and landscape pages then line up in rows, and a turn moves no other
    page. One column keeps each paper its own size, as it always has. */
function gridFrame(columns: number) {
  return columns > 1 ? THUMBNAIL_WIDTH : null
}

type ColumnDrag = {
  /** The page list the drag was measured against: an edit landing under it
      ends the preview, and the reorder's own commit is one. */
  basis: PdfPageInfo[]
  /** Where among the pages that stay the block lands, or null while the
      pointer is away and every page stands where it was. */
  at: number | null
  moving: number[]
}

type SidebarThumbnailsProps = {
  /** A background tab's column is laid out only once its tab is shown. */
  active: boolean
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
  /** Files chosen from disk, added at the end as files of their own. */
  onAddFiles: () => void
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
  onNavigate: (pageNumber: number) => void
  onPastePages: (index: number, section?: number) => void
  /** Settles once the reorder has landed or been refused: the column holds
      the dropped order until then, rather than flash the old one. `moving`
      joins `section`, the file it was let go among. */
  onReorderPages: (order: number[], moving: number[], section?: number) => Promise<unknown>
  /** A page's own turn control: that page alone, chosen or not. */
  onRotatePage: (pageNumber: number, degrees: 90 | 270) => void
  onRotatePages: (degrees: 90 | 270) => void
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  pages: PdfPageInfo[]
  /** The document's files, once more than one: their names head their pages. */
  sections: PdfSection[]
  /** Where a preview waits while an edit has its page out of the document. */
  parkedPreviews: ParkedPreviews
  renderEpochs: RenderEpochs
  selectedPages: ReadonlySet<number>
  /** Follow each page through a reorder, so its painted preview moves with it. */
  thumbnailKeys: number[]
  viewRotation: number
}

/** The document's pages down the sidebar: where the reader finds a page, and
    where pages are chosen, reordered, turned and removed. */
export function SidebarThumbnails({
  active,
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
  onAddFiles,
  onFileOptionsChange,
  onFileRowsChange,
  onFocusChange,
  onInsertBlankPage,
  onInsertCarriedPages,
  onMenuPage,
  onNavigate,
  onPastePages,
  onReorderPages,
  onRotatePage,
  onRotatePages,
  onSelectPage,
  padding,
  pages,
  parkedPreviews,
  renderEpochs,
  sections,
  selectedPages,
  thumbnailKeys,
  viewRotation,
}: SidebarThumbnailsProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLOListElement>(null)
  const current = useCurrentPage(currentPage)
  const followedRef = useRef<number | null>(null)
  const [menu, setMenu] = useState<{
    pageNumber: number
    pages: PdfPageInfo[]
  } | null>(null)
  // An edit can land under the open menu and renumber the pages; the menu then
  // closes rather than act on whatever holds its number now.
  const menuPage = menu?.pages === pages ? menu.pageNumber : null
  const [drag, setDrag] = useState<ColumnDrag | null>(null)
  // Thumbnail keys, not page numbers: a hole outlives the reorder's commit
  // until the ghost has settled into it.
  const [holes, setHoles] = useState(NO_HOLES)
  const [ghost, setGhost] = useState<PageDragGhostState | null>(null)
  const [landing, setLanding] = useState<{
    /** Where the ghost lands instead, outside this column; null fades it. */
    box?: { left: number; top: number } | null
    /** The pressed page's thumbnail key: the ghost lands on its hole. */
    leadKey: number
    onLanded?: () => void
    settled: Promise<unknown>
  } | null>(null)
  const carry = usePageCarryContext()
  // The flip layout is told about the holes, and opens them: its `prime`
  // is reached through a ref the layout fills in below.
  const primeRef = useRef(() => {})
  const primeIncoming = useCallback(() => primeRef.current(), [])
  // The file of the page a drop lands nearest, other than those in hand: a
  // drop between two files' pages joins the one it was let go beside.
  const sectionNear = useCallback(
    (point: { x: number; y: number }, moving: (key: string) => boolean) => {
      const cells = Array.from(
        columnRef.current?.querySelectorAll<HTMLElement>(":scope > [data-flip-key]") ?? [],
      ).filter((cell) => !moving(cell.dataset.flipKey!))
      const nearest = cells[nearestBox(point, cells.map((cell) => cell.getBoundingClientRect()))]
      const paper = nearest?.querySelector<HTMLElement>("[data-thumbnail-page]")

      return paper ? pagesRef.current[Number(paper.dataset.thumbnailPage) - 1]?.section : undefined
    },
    [],
  )
  const insertCarried = useCallback(
    (carried: CarriedPages, index: number, point: { x: number; y: number }) =>
      onInsertCarriedPages(
        carried,
        index,
        sectionNear(point, (key) => key.startsWith(CARRY_KEY)),
      ),
    [onInsertCarriedPages, sectionNear],
  )
  const incoming = useIncomingPages({
    columnRef,
    documentId,
    onInsert: insertCarried,
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
  const keysRef = useRef(thumbnailKeys)
  const isEditingRef = useRef(isEditingNow)
  // A column gone before its ghost is down still lets the taker's holes close.
  const pendingLandedRef = useRef<(() => void) | undefined>(undefined)
  const [columns, setColumns] = useState(1)
  const frame = gridFrame(columns)
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
  keysRef.current = thumbnailKeys
  isEditingRef.current = isEditingNow

  // Every width the reader drags the sidebar to, not only the window's.
  useLayoutEffect(() => {
    const list = listRef.current

    if (!list) {
      return
    }

    const fit = (width: number) => {
      // A background tab's column has no box; it keeps the columns it had.
      if (width > 0) {
        setColumns(thumbnailColumns(width, THUMBNAIL_WIDTH))
      }
    }
    const observer = new ResizeObserver(([entry]) => fit(entry?.contentRect.width ?? 0))
    const style = getComputedStyle(list)

    // Before the first paint too: the observer's first report lands a frame
    // late, which would show a stored wide sidebar as one column first.
    fit(list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    observer.observe(list)

    return () => observer.disconnect()
  }, [])

  // One page's own controls act on that page alone. Read through a ref, so the
  // memoised previews keep one handler across the session's every render.
  const actionsRef = useRef({ onDeleteOnePage, onRotatePage, onSelectPage })

  actionsRef.current = { onDeleteOnePage, onRotatePage, onSelectPage }

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
        // The control leaves with its page, and a removed element fires no
        // blur: the column keeps the focus, and with it the page keys. A click
        // focuses the control too, except in WebKit on macOS.
        if (listRef.current?.contains(document.activeElement)) {
          listRef.current?.focus({ preventScroll: true })
        }

        actions.onDeleteOnePage(pageNumber)
        break
    }
  }, [])

  // A column unmounted with focus in it (an overlay dismissed, the sidebar
  // hidden) fires no blur, which would leave the clipboard keys on the pages.
  useEffect(() => () => onFocusChange(false), [onFocusChange])

  useEffect(() => () => pendingLandedRef.current?.(), [])

  // Only when the reader's page changes, never on every render: a reader
  // scrolling the column to look further ahead must not be pulled back.
  useLayoutEffect(() => {
    const list = listRef.current
    const paper = list?.querySelector<HTMLElement>(
      `[data-thumbnail-page="${current}"]`,
    )

    if (
      !active ||
      !list ||
      !paper ||
      followedRef.current === current ||
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
  }, [active, current])

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
            "[data-thumbnail-page]",
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

  const startDrag = (event: ReactPointerEvent) => {
    const paper = (event.target as Element).closest<HTMLElement>(
      "[data-thumbnail-page]",
    )
    const list = listRef.current
    const column = columnRef.current

    if (event.button !== 0 || !paper || !list || !column || settlingRef.current) {
      return
    }

    const pressed = Number(paper.dataset.thumbnailPage)
    const basis = pagesRef.current
    const keys = keysRef.current
    const keyOf = (pageNumber: number) => keys[pageNumber - 1] ?? pageNumber - 1
    const leadKey = keyOf(pressed)
    const start = { x: event.clientX, y: event.clientY }
    let moving: number[] | null = null
    let movingKeys: ReadonlySet<string> = new Set()
    let carried: CarriedPages | null = null
    // Out over the tab strip or another tab's column, where the window answers.
    let carrying = false
    let at: number | null = null
    let point = start
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

      // The strip runs past the column's edge, and is the way to other tabs.
      const home = beside() && !stripSpotAt(point)

      if (!home && carry && carried) {
        carrying = true
        carry.move(carried, point)
      } else if (carrying) {
        carrying = false
        carry?.cancel()
      }

      const next =
        home && pagesRef.current === basis
          ? flowLanding(
              pointInColumn(column, point),
              // Cells only: a page leaving fades among them, keyless.
              flowCells(column, (key) => movingKeys.has(key)),
              at,
            )
          : null

      if (next !== at) {
        at = next
        setDrag({ at, basis, moving })
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

        const chosen = selectionRef.current.has(pressed)

        moving = chosen
          ? [...selectionRef.current].sort((left, right) => left - right)
          : [pressed]
        movingKeys = new Set(moving.map((pageNumber) => String(keyOf(pageNumber))))
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

        if (!chosen) {
          onSelectPage(pressed, { range: false, toggle: false })
        }

        prime()
        setHoles(new Set(moving.map(keyOf)))
        setDrag({ at, basis, moving })
        setGhost(liftGhost(paper, moving.length, start, point))
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

      if (commit) {
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
        settlingRef.current = true
        setDrag({ at, basis, moving })
        setLanding({
          box: taken ? taken.box : undefined,
          leadKey,
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
      const nearest = reorder ? sectionNear(point, (key) => movingKeys.has(key)) : undefined
      // Let go where they stand but beside the next file's first page, they
      // join it — unless that would leave their own file with no page at all:
      // a one-page file's page let go in place stays its file's.
      const block = moving
      const emptiesFile = block.some((pageNumber) => {
        const own = basis[pageNumber - 1]?.section

        return (
          own !== undefined &&
          basis.every((page, index) => page.section !== own || block.includes(index + 1))
        )
      })
      const section = !moved && emptiesFile ? undefined : nearest
      const regrouped =
        section !== undefined &&
        moving.some((pageNumber) => basis[pageNumber - 1]?.section !== section)
      const changes = moved || (reorder !== null && regrouped)

      // Otherwise the pages go back where they were and the ghost with them.
      if (!changes) {
        at = null
      }

      settlingRef.current = true
      setDrag({ at, basis, moving })
      setLanding({
        leadKey,
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
  // Stood down while pages are in hand: a drop lays the blanks out afresh.
  const blanks = new Map(
    drag || incoming ? [] : padding.map((sheet) => [sheet.after, sheet] as const),
  )
  let headed: number | undefined

  return (
    <div
      className="flex h-full flex-col"
      // Pages under a stack in hand, this column's or another tab's, show none
      // of their controls.
      data-pages-dragging={drag !== null || ghost !== null || incoming !== null ? "" : undefined}
      data-sidebar-pages
    >
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b px-2"
        data-slot="sidebar-pages-bar"
      >
        {sections.length > 1 ? (
          <ToolbarTooltip label={t("sidebar.fileRows")}>
            <Toggle
              aria-label={t("sidebar.fileRows")}
              className="size-7 min-w-7 p-0"
              data-slot="sidebar-file-rows"
              onPressedChange={onFileRowsChange}
              pressed={fileRows}
              size="sm"
            >
              <Rows3 />
            </Toggle>
          </ToolbarTooltip>
        ) : null}
        {fileOptions ? (
          <>
            <ToolbarTooltip label={t("sidebar.smartPadding")}>
              <Toggle
                aria-label={t("sidebar.smartPadding")}
                className="size-7 min-w-7 p-0"
                data-slot="sidebar-smart-padding"
                onPressedChange={(smartPadding) =>
                  onFileOptionsChange({ smartPadding })
                }
                pressed={fileOptions.smartPadding}
                size="sm"
              >
                <BetweenHorizontalStart />
              </Toggle>
            </ToolbarTooltip>
            <ToolbarTooltip label={t("sidebar.fileBookmarks")}>
              <Toggle
                aria-label={t("sidebar.fileBookmarks")}
                className="size-7 min-w-7 p-0"
                data-slot="sidebar-file-bookmarks"
                onPressedChange={(perFileBookmarks) =>
                  onFileOptionsChange({ perFileBookmarks })
                }
                pressed={fileOptions.perFileBookmarks}
                size="sm"
              >
                <Bookmark />
              </Toggle>
            </ToolbarTooltip>
          </>
        ) : null}
        <ToolbarTooltip label={t("sidebar.addFiles")}>
          <Button
            aria-label={t("sidebar.addFiles")}
            className="ml-auto"
            data-slot="sidebar-add-files"
            onClick={onAddFiles}
            size="icon-sm"
            variant="ghost"
          >
            <FilePlus2 />
          </Button>
        </ToolbarTooltip>
      </div>
      <div className="relative min-h-0 flex-1">
        <ContextMenu
          onOpenChange={(open) => {
            if (!open) {
              setMenu(null)
            }
          }}
          // Opened by a press on a page alone: elsewhere in the column there is
          // nothing for the entries to act on.
          open={menuPage !== null}
        >
          <ContextMenuTrigger
            render={
              <div
                aria-label={t("sidebar.thumbnails")}
                className="overlay-scroll-viewport h-full overflow-y-auto overscroll-contain px-2 pt-3 pb-4 outline-none select-none"
                data-slot="sidebar-thumbnails"
                data-thumbnail-scroll-root
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    onFocusChange(false)
                  }
                }}
                onContextMenu={(event) => {
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
                  setMenu({ pageNumber, pages })
                }}
                onFocus={() => onFocusChange(true)}
                onKeyDown={(event) => {
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
                frame === null ? "flex-col items-center gap-3" : "mx-auto flex-wrap",
              )}
              data-thumbnail-columns={columns}
              ref={columnRef}
              style={
                frame === null
                  ? undefined
                  : {
                      columnGap: THUMBNAIL_GRID_GAP,
                      rowGap: THUMBNAIL_GRID_GAP,
                      width: columns * frame + (columns - 1) * THUMBNAIL_GRID_GAP,
                    }
              }
            >
              {/* Flat, so each preview keeps its key among the column's rows. */}
              {[...order, null].flatMap((pageNumber, index) => {
                const holesHere =
                  index === incomingAt ? (
                    <CarriedHoles
                      frame={frame}
                      key={CARRY_KEY}
                      rotation={viewRotation}
                      sizes={incoming!.carried.sizes}
                    />
                  ) : null

                if (pageNumber === null) {
                  return [holesHere]
                }

                const page = pages[pageNumber - 1]!
                const key = thumbnailKeys[pageNumber - 1] ?? pageNumber - 1
                const carriedAhead =
                  incomingAt !== null && index >= incomingAt ? incoming!.carried.pages.length : 0
                const heads =
                  byFile && !moving.has(pageNumber) && page.section !== headed
                    ? page.section
                    : undefined

                if (heads !== undefined) {
                  headed = heads
                }

                return [
                  holesHere,
                  heads === undefined ? null : (
                    // No flip key: a heading is no page, and a drop counts none.
                    <li
                      className="w-full basis-full truncate px-1 pt-1 text-xs font-medium text-muted-foreground"
                      data-section-header={heads}
                      key={`section-${heads}-${pageNumber}`}
                    >
                      {titles.get(heads)}
                    </li>
                  ),
                  <SidebarThumbnail
                    // Where the page stands in a drag's preview, as it will once
                    // the pages land.
                    caption={index + 1 + carriedAhead}
                    // A document keeps one page; the backend refuses a delete of them all.
                    deleteDisabled={numPages <= 1}
                    documentId={documentId}
                    flipKey={key}
                    frame={frame}
                    hole={holes.has(key) || arrived.has(key)}
                    intrinsicRotation={page.rotation}
                    isCurrent={current === pageNumber}
                    isCut={cutPages.has(pageNumber)}
                    isSelected={selectedPages.has(pageNumber)}
                    key={key}
                    onAction={act}
                    onNavigate={onNavigate}
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
                      frame={frame}
                      key={`padding-${key}`}
                      label={t("sidebar.paddingPage")}
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
        <PagesDropTarget />
      </div>
    </div>
  )
}

/** Shown over the column while a file drag offers it; a drop there adds the
    files to this document. */
function PagesDropTarget() {
  const { t } = useTranslation()
  const drop = usePagesDrop()

  if (!drop) {
    return null
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed p-3 text-center backdrop-blur-sm",
        drop === "over"
          ? "border-primary/70 bg-background/90"
          : "border-muted-foreground/40 bg-background/75 text-muted-foreground",
      )}
      data-over={drop === "over" ? "" : undefined}
      data-testid="sidebar-pages-drop"
    >
      <div className="flex flex-col items-center">
        <FilePlus2 className="mb-3 size-8" />
        <p className="text-sm font-semibold">{t("sidebar.dropFiles")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("sidebar.dropFilesHint")}</p>
      </div>
    </div>
  )
}

/** Where another document's pages will stand, one hole each, keyed apart from
    every page; a fragment, so each is a row of the column's own. Turned as
    this view turns its pages, which the copies take on, not as the source's. */
function CarriedHoles({
  frame,
  rotation,
  sizes,
}: {
  frame: number | null
  rotation: number
  sizes: CarriedPages["sizes"]
}) {
  return sizes.map((size, index) => {
    const paper = thumbnailPaper(dimensionsForRotation(rotation, size.width, size.height))

    return (
      <li className="relative" data-flip-key={`${CARRY_KEY}${index}`} key={index}>
        <div
          style={{
            height: `calc(${frame ?? paper.height}px + ${THUMBNAIL_CAPTION_HEIGHT})`,
            width: frame ?? paper.width,
          }}
        />
        <DragHole
          height={paper.height}
          top={frame === null ? 0 : (frame - paper.height) / 2}
          width={paper.width}
        />
      </li>
    )
  })
}

/** A blank page a Save As will add, where it will add it: white paper with a
    dashed edge, no page of the document's own, so nothing to choose or drag.
    No flip key, so a drop counts it no cell. */
function PaddingCell({
  frame,
  label,
  rotation,
  sheet,
}: {
  frame: number | null
  label: string
  rotation: number
  sheet: PaddingSheet
}) {
  const paper = thumbnailPaper(dimensionsForRotation(rotation, sheet.width, sheet.height))

  return (
    <li className="flex flex-col items-center" data-padding-after={sheet.after}>
      <div
        className="grid place-items-center"
        style={frame === null ? undefined : { height: frame, width: frame }}
      >
        <HintTooltip label={label}>
          <div
            aria-label={label}
            className="border-2 border-dashed border-muted-foreground/40 bg-white"
            role="img"
            style={{ height: paper.height, width: paper.width }}
          />
        </HintTooltip>
      </div>
      <span style={{ height: THUMBNAIL_CAPTION_HEIGHT }} />
    </li>
  )
}

/** Memoised on primitives alone, so the reader's page moving re-renders the
    two previews it moves between, not the column. */
const SidebarThumbnail = memo(function SidebarThumbnail({
  caption,
  deleteDisabled,
  documentId,
  flipKey,
  frame,
  hole,
  intrinsicRotation,
  isCurrent,
  isCut,
  isSelected,
  onAction,
  onNavigate,
  onSelect,
  pageHeight,
  pageNumber,
  pageWidth,
  parked,
  renderEpoch,
  rotation,
  signed,
}: {
  caption: number
  deleteDisabled: boolean
  documentId: number
  flipKey: number
  /** The square cell of a widened sidebar's grid, or null down one column. */
  frame: number | null
  /** The page is in hand: its place shows where it will land. */
  hole: boolean
  intrinsicRotation: number
  isCurrent: boolean
  isCut: boolean
  isSelected: boolean
  onAction: PageActionHandler
  onNavigate: (pageNumber: number) => void
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  pageHeight: number
  pageNumber: number
  pageWidth: number
  parked: ParkedPreviews
  renderEpoch: number
  rotation: number
  signed: boolean
}) {
  const itemRef = useRef<HTMLLIElement>(null)
  const nearView = useNearViewport(itemRef, RETAIN_MARGIN)
  // A focused control stays however far the column scrolls from it: unmounting
  // it would drop keyboard focus back to the start of the document.
  const [focusWithin, setFocusWithin] = useState(false)
  const paper = thumbnailPaper(dimensionsForRotation(rotation, pageWidth, pageHeight))
  // Each control carries a tooltip; hundreds would slow every selection.
  const showControls = nearView || focusWithin

  // A control hidden or removed under focus may send no blur. Check again as
  // the page leaves the view, where a stale flag would keep its controls.
  useEffect(() => {
    if (!nearView && focusWithin && !itemRef.current?.contains(document.activeElement)) {
      setFocusWithin(false)
    }
  }, [focusWithin, nearView])

  return (
    <li
      className="relative"
      data-flip-key={flipKey}
      onBlur={(event) => {
        // Leaving the window blurs with no `relatedTarget` but keeps
        // `activeElement`, and focus comes back to the same control.
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !event.currentTarget.contains(document.activeElement)
        ) {
          setFocusWithin(false)
        }
      }}
      onFocus={() => setFocusWithin(true)}
      ref={itemRef}
    >
      {/* Faded rather than hidden: a hidden button would give up its focus,
          and the column's keys with it. */}
      <div className={cn(hole && "opacity-0")}>
        <PdfThumbnail
          caption={caption}
          documentId={documentId}
          frame={frame === null ? undefined : { height: frame, width: frame }}
          intrinsicRotation={intrinsicRotation}
          isCurrent={isCurrent}
          isCut={isCut}
          isSelected={isSelected}
          mark={signed ? <PageSignatureMark /> : undefined}
          onOpen={onNavigate}
          onSelect={onSelect}
          overlay={
            showControls ? (
              <PageControls
                caption={caption}
                deleteDisabled={deleteDisabled}
                isSelected={isSelected}
                itemKey={pageNumber}
                onAction={onAction}
              />
            ) : null
          }
          pageHeight={pageHeight}
          pageNumber={pageNumber}
          pageWidth={pageWidth}
          parkKey={flipKey}
          parked={parked}
          renderEpoch={renderEpoch}
          retainBitmap={nearView}
          rotation={rotation}
        />
      </div>
      {hole ? (
        <DragHole
          height={paper.height}
          top={frame === null ? 0 : (frame - paper.height) / 2}
          width={paper.width}
        />
      ) : null}
    </li>
  )
})

