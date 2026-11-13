import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react"
import { ChevronRight, FileText, Pencil, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { BookmarkItems } from "@/components/BookmarkList"
import { FileTitleEditor } from "@/components/FileTitleEditor"
import { HintTooltip } from "@/components/HintTooltip"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { FileMenuContent } from "@/components/PageContextMenu"
import { dropEdgeOrigin, SidebarDropEdge } from "@/components/SidebarFileDrop"
import { OutlineBar } from "@/components/SidebarPanelTools"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useListDrag } from "@/hooks/useListDrag"
import { useDropEdgeScroll, useSidebarDrop, useSidebarDropPoint } from "@/hooks/useSidebarDrop"
import {
  fileFoldKey,
  foldableBookmarks,
  foldAllOf,
  nestsBookmarks,
  sectionOutlineKey,
  toggledFold,
  type OutlineFolds,
} from "@/lib/outlineFolds"
import { DRAG_CLICK_WINDOW, dropGapForRow } from "@/lib/pageDrag"
import { fileRuns, type FileRun } from "@/lib/pageSections"
import type { PdfPageInfo, PdfSection } from "@/lib/pdf"
import { cn } from "@/lib/utils"

export type FileSectionsTreeHandle = {
  /** How many pages come before files let go at `point` on screen, between
      two of the runs listed; null for after the last. */
  fileDropSlot: (point: { x: number; y: number }) => number | null
}

type FileSectionsTreeProps = {
  canPaste: boolean
  /** The files folded to their names, and their bookmarks folded, by key. */
  folds: OutlineFolds
  onFoldsChange: (folds: OutlineFolds) => void
  /** A file dragged among the others: its pages go, whole, in front of
      1-based page `before`, or to the end. */
  onMove: (sectionId: number, before: number | null) => void
  onNavigate: (pageNumber: number) => void
  /** The pages on the clipboard pasted into a file, in front of 1-based
      page `index`. */
  onPaste: (sectionId: number, index: number) => void
  onRemove: (sectionId: number) => void
  onRename: (sectionId: number, title: string) => void
  pages: PdfPageInfo[]
  ref?: Ref<FileSectionsTreeHandle>
  sections: PdfSection[]
}

/** The runs down the list, each by its name's row (not its bookmarks below)
    and the page it starts on, 1-based. */
function runRows(list: HTMLUListElement) {
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > li[data-run-first]"), (item) => {
    const { height, top } = (
      item.querySelector("[data-slot='file-section-row']") ?? item
    ).getBoundingClientRect()

    return { first: Number(item.dataset.runFirst), height, item, top }
  })
}

/** Which run files let go at `y` go in front of, or null for after the last. */
function runLanding(list: HTMLUListElement, y: number | null) {
  const rows = runRows(list)
  const before = y === null ? rows.length : dropGapForRow(y, rows)

  return { before: rows[before] ?? null, rows }
}

/**
 * A document of several files, each under its name with its own bookmarks:
 * the outline a Save As writes, one bookmark per run of a file's pages, the
 * file's own beneath its first. A name is where that run's first page stands;
 * a file can be renamed, removed, or dragged among the others, every file
 * folded to its name meanwhile. A row ends on how many pages it holds, which
 * give their place to its rename and remove buttons under the pointer.
 */
export function FileSectionsTree({
  canPaste,
  folds,
  onFoldsChange,
  onMove,
  onNavigate,
  onPaste,
  onRemove,
  onRename,
  pages,
  ref,
  sections,
}: FileSectionsTreeProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const drop = useSidebarDrop()

  useDropEdgeScroll(navRef)

  useImperativeHandle(
    ref,
    () => ({
      fileDropSlot: (point) => {
        const list = listRef.current
        const before = list ? runLanding(list, point.y).before : null

        return before ? before.first - 1 : null
      },
    }),
    [],
  )
  const draggedAtRef = useRef(0)
  const runs = fileRuns(pages)
  const files = new Map(sections.map((section) => [section.id, section]))
  const filePages = new Map<number, number>()

  for (const run of runs) {
    filePages.set(run.section, (filePages.get(run.section) ?? 0) + run.count)
  }

  const { drag } = useListDrag({
    active: editing === null,
    listRef,
    onReorder: (moved, to) => {
      const from = moved[0]!
      const rest = runs.filter((_, index) => index !== from)

      draggedAtRef.current = performance.now()
      onMove(runs[from]!.section, rest[to]?.first ?? null)
    },
    // The name alone is the handle: the file's bookmarks and buttons are pressed.
    pressOnly: (target) => target.closest("[data-slot='file-section-title']") === null,
  })
  const dragged = drag ? files.get(runs[drag.index]?.section ?? -1) : undefined

  // A file's bookmarks stand under its first run alone, so it folds once.
  const foldable = sections.filter((section) => section.outline.length > 0)
  const foldAll = foldAllOf(
    folds,
    foldable.map((section) => fileFoldKey(section.id)),
    foldable.flatMap((section) => [
      fileFoldKey(section.id),
      ...foldableBookmarks(section.outline, sectionOutlineKey(section.id)),
    ]),
  )

  return (
    <div className="flex h-full flex-col">
      <OutlineBar
        dropLabel={t("sidebar.dropFiles")}
        fold={{
          canFold: foldAll.canFold,
          canUnfold: foldAll.canUnfold,
          foldLabel: t("sidebar.foldAll"),
          onFold: (folded) => onFoldsChange(foldAll.fold(folded)),
          unfoldLabel: t("sidebar.unfoldAll"),
        }}
      />
      <div className="relative min-h-0 flex-1" data-sidebar-drop-list>
        <nav
          aria-label={t("sidebar.files")}
          className="overlay-scroll-viewport h-full overflow-auto overscroll-contain p-2"
          data-slot="file-sections"
          ref={navRef}
        >
          <ul className="flex flex-col gap-0.5" ref={listRef}>
            {runs.map((run, index) => {
              const section = files.get(run.section)
              const rowKey = `${run.section}:${run.ordinal}`

              if (!section) {
                return null
              }

              return (
                <FileRunRow
                  canPaste={canPaste}
                  dragging={drag !== null}
                  editing={editing === rowKey}
                  folded={folds.has(fileFoldKey(section.id))}
                  folds={folds}
                  index={index}
                  key={rowKey}
                  lifted={drag?.index === index}
                  offset={drag?.cellOffsets[index] ?? 0}
                  onEdit={(on) => setEditing(on ? rowKey : null)}
                  onNavigate={(pageNumber) => {
                    if (performance.now() - draggedAtRef.current >= DRAG_CLICK_WINDOW) {
                      onNavigate(pageNumber)
                    }
                  }}
                  onFoldsChange={onFoldsChange}
                  onNavigateBookmark={onNavigate}
                  onPaste={onPaste}
                  onRemove={onRemove}
                  onRename={onRename}
                  onToggle={() => onFoldsChange(toggledFold(folds, fileFoldKey(section.id)))}
                  // A document keeps a page; the last file's go no further.
                  removeDisabled={(filePages.get(section.id) ?? 0) >= pages.length}
                  run={run}
                  section={section}
                />
              )
            })}
          </ul>
        </nav>
        <OverlayScrollbars viewportRef={navRef} />
        <SidebarDropEdge>
          {drop === "over" ? <FilesDropMarker listRef={listRef} /> : null}
        </SidebarDropEdge>
      </div>
      {drag && dragged ? (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm font-medium shadow-lg"
          style={{
            left: drag.pointer.x + drag.grip.x,
            top: drag.pointer.y + drag.grip.y,
            width: drag.width,
          }}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{dragged.title}</span>
        </div>
      ) : null}
    </div>
  )
}

/** One run of a file's pages, under the file's name. */
function FileRunRow({
  canPaste,
  dragging,
  editing,
  folded,
  folds,
  index,
  lifted,
  offset,
  onEdit,
  onFoldsChange,
  onNavigate,
  onNavigateBookmark,
  onPaste,
  onRemove,
  onRename,
  onToggle,
  removeDisabled,
  run,
  section,
}: {
  canPaste: boolean
  dragging: boolean
  editing: boolean
  folded: boolean
  folds: OutlineFolds
  index: number
  lifted: boolean
  offset: number
  onEdit: (editing: boolean) => void
  onFoldsChange: (folds: OutlineFolds) => void
  onNavigate: (pageNumber: number) => void
  onNavigateBookmark: (pageNumber: number) => void
  onPaste: (sectionId: number, index: number) => void
  onRemove: (sectionId: number) => void
  onRename: (sectionId: number, title: string) => void
  onToggle: () => void
  removeDisabled: boolean
  run: FileRun
  section: PdfSection
}) {
  const { t } = useTranslation()
  const nameRef = useRef<HTMLSpanElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The file's own bookmarks stand under its first run, as a Save As writes them.
  const outline = run.leads ? section.outline : []
  const open = !dragging && !folded && outline.length > 0

  return (
    <li
      // Hidden, not faded: the row making way slides onto its place.
      className={cn(lifted && "opacity-0")}
      data-list-index={index}
      data-run-first={run.first}
      data-section-id={section.id}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
    >
      {/* Off while the name is typed: the field keeps the WebView's own cut,
          copy and paste menu. */}
      <ContextMenu disabled={editing} onOpenChange={setMenuOpen}>
        <ContextMenuTrigger
          render={
            <div
              // A property the row sets, because the count is no child of
              // the buttons that take its place: see `PAPER_CONTROLS_HOST`.
              // The keyboard's focus sets it too, from inside the buttons
              // alone: WebKitGTK can keep a clicked name `:focus-visible`,
              // and its row would stay lit.
              className="relative flex items-center gap-1 rounded-md pr-1 [--row-tools:0] hover:bg-sidebar-accent hover:[--row-tools:1] has-[[data-slot=file-section-tools]_:focus-visible]:bg-sidebar-accent has-[[data-slot=file-section-tools]_:focus-visible]:[--row-tools:1]"
              data-slot="file-section-row"
            />
          }
        >
          <button
            aria-expanded={outline.length > 0 ? open : undefined}
            // Its own name, not the title the file's name beside it goes by.
            aria-label={t(folded ? "sidebar.unfoldItem" : "sidebar.foldItem", {
              name: section.title,
            })}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              outline.length === 0 && "invisible",
            )}
            onClick={onToggle}
            tabIndex={outline.length === 0 ? -1 : 0}
            type="button"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
          {editing ? (
            <FileTitleEditor
              label={t("sidebar.fileName")}
              onDone={(title) => {
                onEdit(false)

                if (title !== null) {
                  onRename(section.id, title)
                }
              }}
              title={section.title}
            />
          ) : (
            <HintTooltip
              label={section.title}
              side="right"
              // Only a name the column cut short has more to say.
              cutShort={nameRef}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                data-slot="file-section-title"
                onClick={() => onNavigate(run.first)}
                onDoubleClick={() => onEdit(true)}
                type="button"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" ref={nameRef}>
                  {section.title}
                </span>
                {/* No narrower than the buttons that stand over it, so they
                    cover no part of a long name. */}
                <span
                  className="ml-auto min-w-13 shrink-0 text-right text-xs font-normal text-muted-foreground tabular-nums opacity-[calc(1_-_var(--row-tools))]"
                  data-slot="file-section-count"
                >
                  {t("sidebar.filePages", { count: run.count })}
                </span>
              </button>
            </HintTooltip>
          )}
          {editing ? null : (
            // Over the count, in its place while the row shows them.
            <div
              className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-(--row-tools)"
              data-slot="file-section-tools"
            >
              <HintTooltip label={t("sidebar.renameFile", { name: section.title })}>
                <Button
                  aria-label={t("sidebar.renameFile", { name: section.title })}
                  data-slot="file-section-rename"
                  onClick={() => onEdit(true)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Pencil />
                </Button>
              </HintTooltip>
              <HintTooltip label={t("sidebar.removeFile", { name: section.title })}>
                <Button
                  aria-label={t("sidebar.removeFile", { name: section.title })}
                  className="hover:text-destructive"
                  data-slot="file-section-remove"
                  disabled={removeDisabled}
                  onClick={() => onRemove(section.id)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <X />
                </Button>
              </HintTooltip>
            </div>
          )}
        </ContextMenuTrigger>
        {/* Gone with the menu, not faded out after it: a menu still on screen
            holds focus in itself, and would take it back from the field a
            rename has just put the caret in. */}
        {menuOpen ? (
          <FileMenuContent
            canPaste={canPaste}
            onPaste={(end) =>
              onPaste(section.id, end === "start" ? run.first : run.first + run.count)
            }
            onRemove={() => onRemove(section.id)}
            onRename={() => onEdit(true)}
            removeDisabled={removeDisabled}
          />
        ) : null}
      </ContextMenu>
      {open ? (
        <ul className="pl-5">
          <BookmarkItems
            folds={folds}
            items={outline}
            onFoldsChange={onFoldsChange}
            onNavigate={onNavigateBookmark}
            parentKey={sectionOutlineKey(section.id)}
            tree={nestsBookmarks(outline)}
          />
        </ul>
      ) : null}
    </li>
  )
}

/** The bar between the runs files would go between, drawn over the list in
    the drop edge's own space: in front of a run's name, or after the last. */
function FilesDropMarker({ listRef }: { listRef: RefObject<HTMLUListElement | null> }) {
  const point = useSidebarDropPoint()
  const markerRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    const host = markerRef.current?.parentElement

    if (!list || !host) {
      setBox(null)
      return
    }

    const { before, rows } = runLanding(list, point?.y ?? null)
    const last = rows.at(-1)

    if (!last) {
      setBox(null)
      return
    }

    // In the middle of the list's own gap between two runs.
    const half = parseFloat(getComputedStyle(list).rowGap) / 2 || 0
    const edge = before
      ? before.item.getBoundingClientRect().top - half
      : last.item.getBoundingClientRect().bottom + half
    // Clear of the dashed line at either side.
    const origin = dropEdgeOrigin(host)
    const span = list.getBoundingClientRect()

    setBox({
      left: span.left - origin.left + 4,
      top: edge - origin.top - 1.5,
      width: span.width - 8,
    })
  }, [listRef, point])

  return (
    <div
      className="absolute h-[3px] rounded-full bg-primary"
      data-testid="files-drop-marker"
      hidden={box === null}
      ref={markerRef}
      style={box ?? undefined}
    />
  )
}
