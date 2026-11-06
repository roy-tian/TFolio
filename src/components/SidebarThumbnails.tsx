import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { Layers } from "lucide-react"
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
import { PageMenuContent } from "@/components/PageContextMenu"
import { PdfThumbnail } from "@/components/PdfThumbnail"
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
  columnLanding,
  exceedsDragThreshold,
  orderWithBlockAt,
} from "@/lib/pageDrag"
import type { ParkedPreviews } from "@/lib/parkedPreviews"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import { cn } from "@/lib/utils"
import { THUMBNAIL_CAPTION_HEIGHT, thumbnailPaper } from "@/lib/viewMode"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"
// The click a drag ends on belongs to the drag; one later than this is a choice.
const DRAG_CLICK_GRACE_MS = 300
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
  /** Copies another document's pages in before this 1-based page. Null where
      the document cannot take them now; else settles on whether they landed. */
  onInsertCarriedPages: (carried: CarriedPages, index: number) => Promise<boolean> | null
  /** A page edit in flight is about to renumber the pages a drag names. */
  isEditingNow: () => boolean
  /** A right-click, before its menu opens: a page outside the selection
      becomes the selection, so the menu means what is on screen. */
  onMenuPage: (pageNumber: number) => void
  onNavigate: (pageNumber: number) => void
  onPastePages: (index: number) => void
  /** Settles once the reorder has landed or been refused: the column holds
      the dropped order until then, rather than flash the old one. */
  onReorderPages: (order: number[]) => Promise<unknown>
  onRotatePages: (degrees: 90 | 270) => void
  onSelectPage: (pageNumber: number, modifiers: SelectionModifiers) => void
  pages: PdfPageInfo[]
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
  isEditingNow,
  onFocusChange,
  onInsertBlankPage,
  onInsertCarriedPages,
  onMenuPage,
  onNavigate,
  onPastePages,
  onReorderPages,
  onRotatePages,
  onSelectPage,
  pages,
  parkedPreviews,
  renderEpochs,
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
  const incoming = useIncomingPages({
    columnRef,
    documentId,
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
  const keysRef = useRef(thumbnailKeys)
  const isEditingRef = useRef(isEditingNow)
  // A column gone before its ghost is down still lets the taker's holes close.
  const pendingLandedRef = useRef<(() => void) | undefined>(undefined)
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
          ? columnLanding(
              point.y - column.getBoundingClientRect().top,
              // Rows only: a page leaving fades among them, keyless.
              Array.from(
                column.querySelectorAll<HTMLElement>(":scope > [data-flip-key]"),
                (row) => ({
                  height: row.offsetHeight,
                  moving: movingKeys.has(row.dataset.flipKey!),
                  top: row.offsetTop,
                }),
              ),
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

  // The page pressed alone only until its click's selection lands. Blanks and
  // pastes go before the first or after the last, as on the organize board.
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

  return (
    <div className="relative h-full" data-sidebar-pages>
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
          {/* Positioned: the slides read each row's place off it. */}
          <ol className="relative flex flex-col items-center gap-3" ref={columnRef}>
            {/* Flat, so each preview keeps its key among the column's rows. */}
            {[...order, null].flatMap((pageNumber, index) => {
              const holesHere =
                index === incomingAt ? (
                  <CarriedHoles
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

              return [
                holesHere,
                <SidebarThumbnail
                  // Where the page stands in a drag's preview, as it will once
                  // the pages land.
                  caption={index + 1 + carriedAhead}
                  documentId={documentId}
                  flipKey={key}
                  hole={holes.has(key) || arrived.has(key)}
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
                  parked={parkedPreviews}
                  renderEpoch={renderEpochs[pageNumber] ?? 0}
                  rotation={viewRotation}
                />,
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
              onInsertBlankPage(side === "before" ? menuFirst : menuLast + 1)
            }
            onPaste={(side) => onPastePages(side === "before" ? menuFirst : menuLast + 1)}
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
  )
}

/** Shown over the column while a file drag offers it; a drop there combines
    the files with this one in the organize workspace. */
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
        <Layers className="mb-3 size-8" />
        <p className="text-sm font-semibold">{t("organize.mergeDropNow")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("organize.mergeDropHint")}</p>
      </div>
    </div>
  )
}

/** Where another document's pages will stand, one hole each, keyed apart from
    every page; a fragment, so each is a row of the column's own. Turned as
    this view turns its pages, which the copies take on, not as the source's. */
function CarriedHoles({
  rotation,
  sizes,
}: {
  rotation: number
  sizes: CarriedPages["sizes"]
}) {
  return sizes.map((size, index) => {
    const paper = thumbnailPaper(dimensionsForRotation(rotation, size.width, size.height))

    return (
      <li className="relative" data-flip-key={`${CARRY_KEY}${index}`} key={index}>
        <div
          style={{
            height: `calc(${paper.height}px + ${THUMBNAIL_CAPTION_HEIGHT})`,
            width: paper.width,
          }}
        />
        <DragHole height={paper.height} width={paper.width} />
      </li>
    )
  })
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
  parked,
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
  parked: ParkedPreviews
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
          parkKey={flipKey}
          parked={parked}
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

