import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  RotateCw,
  Scissors,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import {
  DragHole,
  landingBox,
  liftGhost,
  PageDragGhost,
  type PageDragGhostHandle,
  type PageDragGhostState,
} from "@/components/PageDragGhost"
import { PdfThumbnail } from "@/components/PdfThumbnail"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"
import { useFlipLayout } from "@/hooks/useFlipLayout"
import { useNearViewport } from "@/hooks/useNearViewport"
import type { RenderEpochs } from "@/lib/annotations"
import { columnLanding, exceedsDragThreshold, orderWithBlockAt } from "@/lib/pageDrag"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { thumbnailPaper } from "@/lib/viewMode"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"
// Near this close to the column's edge, a drag scrolls it.
const EDGE_SCROLL_BAND = 40
const EDGE_SCROLL_STEP = 12
// The click a drag ends on belongs to the drag; one later than this is a choice.
const DRAG_CLICK_GRACE_MS = 300
// A pointer this far beside the column has left it: nothing moves, and letting
// go puts the pages back.
const AWAY_MARGIN = 32
const NO_HOLES: ReadonlySet<number> = new Set()

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
  /** Whether focus is in the column: the clipboard keys are its only then. */
  onFocusChange: (focused: boolean) => void
  /** The page a blank goes in front of, 1-based; one past the last appends. */
  onInsertBlankPage: (index: number) => void
  /** A right-click, before its menu opens: a page outside the selection
      becomes the selection, so the menu means what is on screen. */
  onMenuPage: (pageNumber: number) => void
  onNavigate: (pageNumber: number) => void
  onPastePages: (index: number) => void
  /** Settles once the reorder has landed or been refused: the column holds
      the dropped order until then, rather than flash the old one. */
  onReorderPages: (order: number[]) => Promise<unknown>
  onRotatePages: () => void
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  pages: PdfPageInfo[]
  renderEpochs: RenderEpochs
  rotations: number[]
  selectedPages: ReadonlySet<number>
  /** Follow each page through a reorder, so its painted preview moves with it. */
  thumbnailKeys: number[]
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
  onFocusChange,
  onInsertBlankPage,
  onMenuPage,
  onNavigate,
  onPastePages,
  onReorderPages,
  onRotatePages,
  onSelectPage,
  pages,
  renderEpochs,
  rotations,
  selectedPages,
  thumbnailKeys,
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
    /** The pressed page's thumbnail key: the ghost lands on its hole. */
    leadKey: number
    settled: Promise<unknown>
  } | null>(null)
  const ghostRef = useRef<PageDragGhostHandle>(null)
  // From a release until the column is its own again, a press is no drag.
  const settlingRef = useRef(false)
  const draggedAtRef = useRef(0)
  const selectionRef = useRef(selectedPages)
  const pagesRef = useRef(pages)
  const keysRef = useRef(thumbnailKeys)
  const numPages = pages.length
  const { prime } = useFlipLayout(columnRef, drag !== null || ghost !== null)
  const order =
    drag?.basis === pages && drag.at !== null
      ? orderWithBlockAt(drag.moving, drag.at, numPages)
      : pages.map((_, index) => index + 1)

  selectionRef.current = selectedPages
  pagesRef.current = pages
  keysRef.current = thumbnailKeys

  // A column unmounted with focus in it (an overlay dismissed, the sidebar
  // hidden) fires no blur, which would leave the clipboard keys on the pages.
  useEffect(() => () => onFocusChange(false), [onFocusChange])

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

    const box = landingBox(
      column,
      column.querySelector(`[data-flip-key="${landing.leadKey}"]`),
      "[data-thumbnail-page]",
      listRef.current,
    )
    // A landing that fails still lets the pages back out of their holes.
    void Promise.resolve(ghostRef.current?.land(box))
      .catch(() => {})
      .then(() => {
        setHoles(NO_HOLES)
        setGhost(null)

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
    let at: number | null = null
    let point = start
    let frame = 0

    const beside = () => {
      const bounds = list.getBoundingClientRect()

      return point.x >= bounds.left - AWAY_MARGIN && point.x <= bounds.right + AWAY_MARGIN
    }
    // Read from the column as laid out now — the block where it last landed —
    // and by key, so a preview not yet rendered still reads right.
    const retarget = () => {
      if (!moving) {
        return
      }

      const next =
        beside() && pagesRef.current === basis
          ? columnLanding(
              point.y - column.getBoundingClientRect().top,
              Array.from(column.children as HTMLCollectionOf<HTMLElement>, (row) => ({
                height: row.offsetHeight,
                moving: movingKeys.has(row.dataset.flipKey ?? ""),
                top: row.offsetTop,
              })),
              at,
            )
          : null

      if (next !== at) {
        at = next
        setDrag({ at, basis, moving })
      }
    }
    const edgeScroll = () => {
      const bounds = list.getBoundingClientRect()
      const step = !beside()
        ? 0
        : point.y < bounds.top + EDGE_SCROLL_BAND
          ? -EDGE_SCROLL_STEP
          : point.y > bounds.bottom - EDGE_SCROLL_BAND
            ? EDGE_SCROLL_STEP
            : 0

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

      const reorder =
        commit && at !== null && pagesRef.current === basis
          ? orderWithBlockAt(moving, at, basis.length)
          : null
      const changes = reorder?.some((pageNumber, index) => pageNumber !== index + 1)

      // Otherwise the pages go back where they were and the ghost with them.
      if (!changes) {
        at = null
      }

      settlingRef.current = true
      setDrag({ at, basis, moving })
      setLanding({
        leadKey,
        settled: changes ? onReorderPages(reorder!) : Promise.resolve(),
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

  const menuCount =
    menuPage !== null && selectedPages.has(menuPage) ? selectedPages.size : 1

  return (
    <div className="relative h-full">
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
                const paper = (event.target as Element).closest<HTMLElement>(
                  "[data-thumbnail-page]",
                )

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
          {/* Positioned: the slides read each row's place off it. */}
          <ol className="relative flex flex-col items-center gap-3" ref={columnRef}>
            {order.map((pageNumber, index) => {
              const page = pages[pageNumber - 1]!
              const key = thumbnailKeys[pageNumber - 1] ?? pageNumber - 1

              return (
                <SidebarThumbnail
                  // Where the page stands in a drag's preview, as it will once
                  // the pages land.
                  caption={index + 1}
                  documentId={documentId}
                  flipKey={key}
                  hole={holes.has(key)}
                  intrinsicRotation={page.rotation}
                  isCurrent={current === pageNumber}
                  isCut={cutPages.has(pageNumber)}
                  isSelected={selectedPages.has(pageNumber)}
                  key={key}
                  onNavigate={onNavigate}
                  onSelect={select}
                  pageHeight={page.height}
                  pageNumber={pageNumber}
                  pageWidth={page.width}
                  renderEpoch={renderEpochs[pageNumber] ?? 0}
                  rotation={rotations[pageNumber - 1] ?? 0}
                />
              )
            })}
          </ol>
        </ContextMenuTrigger>
        {menuPage !== null ? (
          <ContextMenuContent>
            <ContextMenuItem data-action="cut-pages" onClick={onCutPages}>
              <Scissors />
              {t("pageEdit.cut", { count: menuCount })}
            </ContextMenuItem>
            <ContextMenuItem data-action="copy-pages" onClick={onCopyPages}>
              <Copy />
              {t("pageEdit.copy", { count: menuCount })}
            </ContextMenuItem>
            {canPaste ? (
              <ContextMenuItem
                data-action="paste-pages"
                onClick={() => onPastePages(menuPage)}
              >
                <ClipboardPaste />
                {t("pageEdit.pasteBefore", { pageNumber: menuPage })}
              </ContextMenuItem>
            ) : null}
            {canPaste && menuPage === numPages ? (
              <ContextMenuItem
                data-action="paste-pages-end"
                onClick={() => onPastePages(numPages + 1)}
              >
                <ClipboardPaste />
                {t("pageEdit.pasteAtEnd")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem data-action="rotate-pages" onClick={onRotatePages}>
              <RotateCw />
              {t("pageEdit.rotate", { count: menuCount })}
            </ContextMenuItem>
            <ContextMenuItem
              data-action="insert-blank-before"
              onClick={() => onInsertBlankPage(menuPage)}
            >
              <FilePlus2 />
              {t("pageEdit.insertBefore", { pageNumber: menuPage })}
            </ContextMenuItem>
            <ContextMenuItem
              data-action="insert-blank-after"
              onClick={() => onInsertBlankPage(menuPage + 1)}
            >
              <FilePlus2 />
              {menuPage === numPages
                ? t("pageEdit.insertAtEnd")
                : t("pageEdit.insertBefore", { pageNumber: menuPage + 1 })}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-action="delete-pages"
              // A document keeps one page; the backend refuses a delete of them all.
              disabled={menuCount >= numPages}
              onClick={() => onDeletePage(menuPage)}
              variant="destructive"
            >
              <Trash2 />
              {t("pageEdit.delete", { count: menuCount })}
            </ContextMenuItem>
          </ContextMenuContent>
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
    </div>
  )
}

/** Memoised on primitives alone, so the reader's page moving re-renders the
    two previews it moves between, not the column. */
const SidebarThumbnail = memo(function SidebarThumbnail({
  caption,
  documentId,
  flipKey,
  hole,
  intrinsicRotation,
  isCurrent,
  isCut,
  isSelected,
  onNavigate,
  onSelect,
  pageHeight,
  pageNumber,
  pageWidth,
  renderEpoch,
  rotation,
}: {
  caption: number
  documentId: number
  flipKey: number
  /** The page is in hand: its place shows where it will land. */
  hole: boolean
  intrinsicRotation: number
  isCurrent: boolean
  isCut: boolean
  isSelected: boolean
  onNavigate: (pageNumber: number) => void
  onSelect: (pageNumber: number, modifiers: SelectionModifiers) => void
  pageHeight: number
  pageNumber: number
  pageWidth: number
  renderEpoch: number
  rotation: number
}) {
  const itemRef = useRef<HTMLLIElement>(null)
  const nearView = useNearViewport(itemRef, RETAIN_MARGIN)
  const paper = thumbnailPaper(dimensionsForRotation(rotation, pageWidth, pageHeight))

  return (
    <li className="relative" data-flip-key={flipKey} ref={itemRef}>
      {/* Faded rather than hidden: a hidden button would give up its focus,
          and the column's keys with it. */}
      <div className={cn(hole && "opacity-0")}>
        <PdfThumbnail
          caption={caption}
          documentId={documentId}
          intrinsicRotation={intrinsicRotation}
          isCurrent={isCurrent}
          isCut={isCut}
          isSelected={isSelected}
          onOpen={onNavigate}
          onSelect={onSelect}
          pageHeight={pageHeight}
          pageNumber={pageNumber}
          pageWidth={pageWidth}
          renderEpoch={renderEpoch}
          retainBitmap={nearView}
          rotation={rotation}
          surface="sidebar"
        />
      </div>
      {hole ? <DragHole height={paper.height} width={paper.width} /> : null}
    </li>
  )
})

