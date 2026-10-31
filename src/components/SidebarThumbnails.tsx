import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  Layers,
  RotateCw,
  Scissors,
  Trash2,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { PdfThumbnail } from "@/components/PdfThumbnail"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"
import { useNearViewport } from "@/hooks/useNearViewport"
import type { RenderEpochs } from "@/lib/annotations"
import { dropGapForRow, exceedsDragThreshold, orderAfterMove } from "@/lib/pageDrag"
import type { PdfPageInfo } from "@/lib/pdf"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"
// Near this close to the column's edge, a drag scrolls it.
const EDGE_SCROLL_BAND = 40
const EDGE_SCROLL_STEP = 12
// The click a drag ends on belongs to the drag; one later than this is a choice.
const DRAG_CLICK_GRACE_MS = 300

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
  onReorderPages: (order: number[]) => void
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
  const current = useCurrentPage(currentPage)
  const followedRef = useRef<number | null>(null)
  const [menu, setMenu] = useState<{
    pageNumber: number
    pages: PdfPageInfo[]
  } | null>(null)
  // An edit can land under the open menu and renumber the pages; the menu then
  // closes rather than act on whatever holds its number now.
  const menuPage = menu?.pages === pages ? menu.pageNumber : null
  const [dropGap, setDropGap] = useState<number | null>(null)
  const [ghost, setGhost] = useState<{ count: number; x: number; y: number } | null>(
    null,
  )
  const draggedAtRef = useRef(0)
  const selectionRef = useRef(selectedPages)
  const numPages = pages.length

  selectionRef.current = selectedPages

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

    if (event.button !== 0 || !paper || !list) {
      return
    }

    const pressed = Number(paper.dataset.thumbnailPage)
    const start = { x: event.clientX, y: event.clientY }
    let moving: number[] | null = null
    let point = start
    let gap: number | null = null
    let frame = 0

    // Papers in page order, measured once the drag starts, in the column's
    // content space: it only scrolls under a drag, never relays itself out.
    const listTop = () => list.getBoundingClientRect().top - list.scrollTop
    let rows: { height: number; top: number }[] = []
    const measureRows = () => {
      const origin = listTop()

      rows = Array.from(
        list.querySelectorAll<HTMLElement>("[data-thumbnail-page]"),
        (row) => {
          const box = row.getBoundingClientRect()

          return { height: box.height, top: box.top - origin }
        },
      )
    }
    const gapAt = (y: number) => dropGapForRow(y - listTop(), rows)
    const retarget = () => {
      gap = gapAt(point.y)
      setDropGap(gap)
    }
    const edgeScroll = () => {
      const bounds = list.getBoundingClientRect()
      const step =
        point.y < bounds.top + EDGE_SCROLL_BAND
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

        moving = selectionRef.current.has(pressed)
          ? [...selectionRef.current].sort((left, right) => left - right)
          : [pressed]

        if (!selectionRef.current.has(pressed)) {
          onSelectPage(pressed, { range: false, toggle: false })
        }

        measureRows()
        frame = requestAnimationFrame(edgeScroll)
      }

      setGhost({ count: moving.length, ...point })
      retarget()
    }
    const finish = (commit: boolean) => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", release)
      document.removeEventListener("pointercancel", cancel)
      document.removeEventListener("keydown", escape, true)

      if (moving) {
        draggedAtRef.current = performance.now()

        if (commit && gap !== null) {
          const order = orderAfterMove(moving, gap, numPages)

          if (order.some((pageNumber, index) => pageNumber !== index + 1)) {
            onReorderPages(order)
          }
        }
      }

      setDropGap(null)
      setGhost(null)
    }
    const release = () => finish(true)
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
            className="h-full overflow-y-auto overscroll-contain px-2 pt-3 pb-4 outline-none select-none"
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
        <ol className="flex flex-col items-center gap-3">
          {pages.map((page, index) => {
            const pageNumber = index + 1

            return (
              <SidebarThumbnail
                documentId={documentId}
                dropAfter={dropGap === numPages && pageNumber === numPages}
                dropBefore={dropGap === index}
                intrinsicRotation={page.rotation}
                isCurrent={current === pageNumber}
                isCut={cutPages.has(pageNumber)}
                isSelected={selectedPages.has(pageNumber)}
                key={thumbnailKeys[index] ?? index}
                onNavigate={onNavigate}
                onSelect={select}
                pageHeight={page.height}
                pageNumber={pageNumber}
                pageWidth={page.width}
                renderEpoch={renderEpochs[pageNumber] ?? 0}
                rotation={rotations[index] ?? 0}
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
      {ghost
        ? createPortal(
            <div
              aria-hidden
              className="pointer-events-none fixed z-60 flex items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-sm shadow-xl ring-1 ring-primary/20"
              style={{ left: ghost.x + 12, top: ghost.y + 12 }}
            >
              <Layers className="size-4 text-muted-foreground" />
              {t("organize.movingPages", { count: ghost.count })}
            </div>,
            document.body,
          )
        : null}
    </ContextMenu>
  )
}

/** Memoised on primitives alone, so the reader's page moving re-renders the
    two previews it moves between, not the column. */
const SidebarThumbnail = memo(function SidebarThumbnail({
  documentId,
  dropAfter,
  dropBefore,
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
  documentId: number
  dropAfter: boolean
  dropBefore: boolean
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

  return (
    <li className="relative" ref={itemRef}>
      {dropBefore ? (
        <span
          aria-hidden
          className="absolute inset-x-0 -top-2 h-0.5 rounded-full bg-primary"
          data-thumbnail-drop
        />
      ) : null}
      <PdfThumbnail
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
      {dropAfter ? (
        <span
          aria-hidden
          className="absolute inset-x-0 -bottom-1 h-0.5 rounded-full bg-primary"
          data-thumbnail-drop
        />
      ) : null}
    </li>
  )
})

