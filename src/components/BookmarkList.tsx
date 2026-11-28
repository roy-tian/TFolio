import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { Bookmark, ChevronRight, Pencil, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { RowTools } from "@/components/FileRow"
import { FileTitleEditor } from "@/components/FileTitleEditor"
import { HintTooltip } from "@/components/HintTooltip"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { SidebarDropEdge } from "@/components/SidebarFileDrop"
import { OutlineBar } from "@/components/SidebarPanelTools"
import { Button } from "@/components/ui/button"
import type { CurrentPage } from "@/hooks/useCurrentPage"
import { scrollOutlineRowIntoView, useFollowOutlineRow } from "@/hooks/useFollowCurrentPage"
import {
  OutlineActiveContext,
  useIsOutlineRowActive,
  useOutlineActive,
  useOutlineActiveKey,
} from "@/hooks/useOutlineActive"
import {
  activeBookmarkKey,
  bookmarkFoldKey,
  bookmarkInsertPath,
  bookmarkParentKey,
  DOCUMENT_OUTLINE_KEY,
  foldableBookmarks,
  foldAllOf,
  nestsBookmarks,
  toggledFold,
  unfoldBookmarkAncestors,
  type OutlineFolds,
} from "@/lib/outlineFolds"
import type { PdfOutlineItem } from "@/lib/pdf"
import { cn } from "@/lib/utils"

const TOP_LEVEL: readonly number[] = []

export type DraftBookmark = {
  pageNumber: number
  path: readonly number[]
}

function pathMatchesPrefix(path: readonly number[], prefix: readonly number[]) {
  return prefix.every((segment, index) => path[index] === segment)
}

function DraftBookmarkRow({
  navRef,
  onDone,
  pageNumber,
  tree,
}: {
  navRef?: RefObject<HTMLElement | null>
  onDone: (title: string | null) => void
  pageNumber: number
  tree: boolean
}) {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const nav = navRef?.current
    const row = rowRef.current

    if (nav && row) {
      scrollOutlineRowIntoView(nav, row, "instant")
    }
  }, [navRef])

  return (
    <li>
      <div
        className={cn(
          "relative flex items-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground",
          tree && "gap-1",
        )}
        data-slot="bookmark-draft-row"
        ref={rowRef}
      >
        {tree ? <span aria-hidden className="size-6 shrink-0" /> : null}
        <FileTitleEditor
          className={cn("mr-1", !tree && "ml-1")}
          label={t("bookmarks.name")}
          onDone={onDone}
          slot="bookmark-title-input"
          title={t("viewer.pageLabel", { pageNumber })}
        />
      </div>
    </li>
  )
}

type BookmarkItemsProps = {
  busy?: boolean
  draft?: DraftBookmark | null
  editingKey?: string | null
  folds: OutlineFolds
  items: PdfOutlineItem[]
  navRef?: RefObject<HTMLElement | null>
  onCommitDraft?: (title: string | null) => void
  onDelete?: (path: number[], parentKey: string, index: number) => void
  onEdit?: (key: string | null) => void
  onFoldsChange: (folds: OutlineFolds) => void
  onNavigate: (pageNumber: number) => void
  onRename?: (path: number[], title: string, previous: string) => void
  parentKey: string
  parentPath?: readonly number[]
  /** Whether the outline nests at all: a flat one keeps no room for arrows. */
  tree: boolean
}

/** The `li`s of one level, for a `ul` the caller owns. Which row stands for
    the page being read comes from `OutlineActiveContext`. */
export function BookmarkItems({
  draft = null,
  items,
  navRef,
  onCommitDraft,
  parentPath = TOP_LEVEL,
  ...shared
}: BookmarkItemsProps) {
  const draftHere =
    draft !== null &&
    draft.path.length === parentPath.length + 1 &&
    pathMatchesPrefix(draft.path, parentPath)
      ? draft.path[parentPath.length]!
      : null
  const draftBelow =
    draft !== null &&
    draft.path.length > parentPath.length + 1 &&
    pathMatchesPrefix(draft.path, parentPath)
      ? draft
      : null
  const rows: ReactNode[] = []

  for (let index = 0; index <= items.length; index += 1) {
    if (draftHere === index && draft !== null && onCommitDraft) {
      rows.push(
        <DraftBookmarkRow
          key={`draft-${shared.parentKey}-${index}`}
          navRef={navRef}
          onDone={onCommitDraft}
          pageNumber={draft.pageNumber}
          tree={shared.tree}
        />,
      )
    }

    const item = items[index]

    if (item !== undefined) {
      rows.push(
        <BookmarkRow
          {...shared}
          draft={draftBelow && draftBelow.path[parentPath.length] === index ? draftBelow : null}
          index={index}
          item={item}
          key={bookmarkFoldKey(shared.parentKey, index)}
          navRef={navRef}
          onCommitDraft={onCommitDraft}
          parentPath={parentPath}
        />,
      )
    }
  }

  return rows
}

type BookmarkRowProps = Omit<BookmarkItemsProps, "items" | "parentPath"> & {
  index: number
  item: PdfOutlineItem
  parentPath: readonly number[]
}

const BookmarkRow = memo(function BookmarkRow({
  busy = false,
  draft = null,
  editingKey = null,
  folds,
  index,
  item,
  navRef,
  onCommitDraft,
  onDelete,
  onEdit,
  onFoldsChange,
  onNavigate,
  onRename,
  parentKey,
  parentPath,
  tree,
}: BookmarkRowProps) {
  const { t } = useTranslation()
  const editable = Boolean(onRename || onDelete)
  const itemKey = bookmarkFoldKey(parentKey, index)
  const itemPath = useMemo(() => [...parentPath, index], [index, parentPath])
  const isActive = useIsOutlineRowActive(itemKey)
  const title = item.title.trim() || t("bookmarks.untitled")
  const nested = item.items.length > 0
  const open = nested && !folds.has(itemKey)
  const isEditing = editingKey === itemKey
  const busyLabel = t("annotate.historyBusy")
  const renameLabel = t("bookmarks.rename", { name: title })
  const deleteLabel = t("bookmarks.delete", { name: title })

  return (
    <li>
      <div
        className={cn(
          "relative flex items-center rounded-md transition-colors [--row-tools:0] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:[--row-tools:1] data-tools-focus:bg-sidebar-accent data-tools-focus:text-sidebar-accent-foreground data-tools-focus:[--row-tools:1]",
          tree && "gap-1",
          isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        )}
        data-outline-current={isActive ? "" : undefined}
        data-slot="bookmark-row"
      >
        {tree ? (
          nested ? (
            <button
              aria-expanded={open}
              // Its own name, not the title the bookmark beside it goes by.
              aria-label={t(open ? "sidebar.foldItem" : "sidebar.unfoldItem", { name: title })}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              data-slot="bookmark-fold"
              onClick={() => onFoldsChange(toggledFold(folds, itemKey))}
              type="button"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            </button>
          ) : (
            <span aria-hidden className="size-6 shrink-0" />
          )
        ) : null}
        {isEditing ? (
          <FileTitleEditor
            className={cn("mr-1", !tree && "ml-1")}
            label={t("bookmarks.name")}
            onDone={(next) => {
              onEdit?.(null)

              if (next !== null) {
                onRename?.(itemPath, next, item.title)
              }
            }}
            slot="bookmark-title-input"
            title={item.title}
          />
        ) : (
          <>
            {/* Beside the sidebar rather than over it: a title too long for a
                column this narrow has nowhere to be read inside it. */}
            <HintTooltip label={title} side="right">
              <button
                aria-current={isActive ? "location" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-50",
                  editable ? "pr-[calc(0.5rem+var(--row-tools)*3rem)]" : "pr-2",
                  !tree && "pl-2",
                )}
                disabled={!item.pageNumber}
                onClick={() => item.pageNumber && onNavigate(item.pageNumber)}
                onDoubleClick={onRename && !busy ? () => onEdit?.(itemKey) : undefined}
                type="button"
              >
                <Bookmark
                  className={cn("size-3.5 shrink-0 text-muted-foreground", isActive && "text-primary")}
                />
                <span className="truncate">{title}</span>
              </button>
            </HintTooltip>
            {editable ? (
              <RowTools
                className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-(--row-tools)"
                data-slot="bookmark-tools"
              >
                {onRename ? (
                  <HintTooltip label={busy ? busyLabel : renameLabel}>
                    <Button
                      aria-label={renameLabel}
                      data-slot="bookmark-rename"
                      disabled={busy}
                      onClick={() => onEdit?.(itemKey)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <Pencil />
                    </Button>
                  </HintTooltip>
                ) : null}
                {onDelete ? (
                  <HintTooltip label={busy ? busyLabel : deleteLabel}>
                    <Button
                      aria-label={deleteLabel}
                      className="not-disabled:hover:text-destructive"
                      data-slot="bookmark-delete"
                      disabled={busy}
                      onClick={() => onDelete(itemPath, parentKey, index)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <X />
                    </Button>
                  </HintTooltip>
                ) : null}
              </RowTools>
            ) : null}
          </>
        )}
      </div>
      {open ? (
        <ul className="pl-5">
          <BookmarkItems
            busy={busy}
            draft={draft}
            editingKey={editingKey}
            folds={folds}
            items={item.items}
            navRef={navRef}
            onCommitDraft={onCommitDraft}
            onDelete={onDelete}
            onEdit={onEdit}
            onFoldsChange={onFoldsChange}
            onNavigate={onNavigate}
            onRename={onRename}
            parentKey={itemKey}
            parentPath={itemPath}
            tree
          />
        </ul>
      ) : null}
    </li>
  )
})

type BookmarkListProps = {
  active: boolean
  busy?: boolean
  currentPage: CurrentPage
  folds: OutlineFolds
  items: PdfOutlineItem[]
  onAddBookmark?: (path: number[], pageNumber: number, title: string, parentKey: string) => void
  onDeleteBookmark?: (path: number[], parentKey: string, index: number) => void
  onFoldsChange: (folds: OutlineFolds) => void
  onNavigate: (pageNumber: number) => void
  onRenameBookmark?: (path: number[], title: string, previous: string) => void
  /** Whose bookmarks these are, as fold keys: the document's, or one file's. */
  rootKey?: string
}

export function BookmarkList({
  active,
  busy = false,
  currentPage,
  folds,
  items,
  onAddBookmark,
  onDeleteBookmark,
  onFoldsChange,
  onNavigate,
  onRenameBookmark,
  rootKey = DOCUMENT_OUTLINE_KEY,
}: BookmarkListProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)
  const [editing, setEditing] = useState<{ items: PdfOutlineItem[]; key: string } | null>(null)
  const [draftState, setDraftState] = useState<{
    items: PdfOutlineItem[]
    pageNumber: number
    path: number[]
  } | null>(null)
  // Drop any in-flight title edit or add draft as soon as `items` updates
  // underneath it so an index-keyed editor can never commit against shifted items.
  const editingKey = editing && editing.items === items ? editing.key : null
  const draft = draftState && draftState.items === items ? draftState : null
  const setEditingKey = useCallback(
    (key: string | null) => {
      if (key !== null && busy) {
        return
      }
      if (key !== null) {
        setDraftState(null)
      }
      setEditing(key === null ? null : { items, key })
    },
    [busy, items],
  )
  const startAdd = useCallback(() => {
    if (busy || !onAddBookmark || draft !== null) {
      return
    }

    const pageNumber = currentPage.get()
    const path = bookmarkInsertPath(items, pageNumber)
    const unfolded = unfoldBookmarkAncestors(folds, rootKey, path)

    if (unfolded !== folds) {
      onFoldsChange(unfolded)
    }

    setEditing(null)
    setDraftState({ items, pageNumber, path })
  }, [busy, currentPage, draft, folds, items, onAddBookmark, onFoldsChange, rootKey])
  const commitDraft = useCallback(
    (title: string | null) => {
      const current = draft

      setDraftState(null)

      if (!current || !onAddBookmark || title === null || title.trim() === "") {
        return
      }

      onAddBookmark(
        current.path,
        current.pageNumber,
        title.trim(),
        bookmarkParentKey(rootKey, current.path),
      )
    },
    [draft, onAddBookmark, rootKey],
  )
  const keyForPage = useCallback(
    (pageNumber: number) =>
      items.length === 0 ? null : activeBookmarkKey(items, rootKey, pageNumber, folds),
    [folds, items, rootKey],
  )
  const outlineActive = useOutlineActive(currentPage, keyForPage)
  const activeKey = useOutlineActiveKey(outlineActive)
  const foldAll = useMemo(
    () =>
      foldAllOf(
        folds,
        items.flatMap((item, index) =>
          item.items.length > 0 ? [bookmarkFoldKey(rootKey, index)] : [],
        ),
        foldableBookmarks(items, rootKey),
      ),
    [folds, items, rootKey],
  )
  const tree = useMemo(() => nestsBookmarks(items), [items])

  useFollowOutlineRow({
    active,
    activeKey,
    currentPage,
    keyForPage,
    navRef,
    paused: editingKey !== null || draft !== null,
  })

  return (
    <div className="flex h-full flex-col">
      {/* Files have no place among the bookmarks: they go last. */}
      <OutlineBar
        add={
          onAddBookmark
            ? {
                active: draft !== null,
                disabled: busy,
                disabledLabel: t("annotate.historyBusy"),
                label: t("bookmarks.add"),
                onAdd: startAdd,
              }
            : undefined
        }
        fold={{
          canFold: foldAll.canFold,
          canUnfold: foldAll.canUnfold,
          foldLabel: t("sidebar.foldBookmarks"),
          onFold: (folded) => onFoldsChange(foldAll.fold(folded)),
          unfoldLabel: t("sidebar.unfoldBookmarks"),
        }}
      />
      <div className="relative min-h-0 flex-1">
        <nav
          aria-label={t("bookmarks.title")}
          className="overlay-scroll-viewport h-full overflow-auto overscroll-contain p-2"
          ref={navRef}
        >
          {/* The panel is the reader's choice of what the sidebar shows,
              whatever the document holds: one with none says so. */}
          {items.length === 0 && draft === null ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t("sidebar.noBookmarks")}</p>
          ) : (
            <ul>
              <OutlineActiveContext.Provider value={outlineActive}>
                <BookmarkItems
                  busy={busy}
                  draft={draft}
                  editingKey={editingKey}
                  folds={folds}
                  items={items}
                  navRef={navRef}
                  onCommitDraft={commitDraft}
                  onDelete={onDeleteBookmark}
                  onEdit={setEditingKey}
                  onFoldsChange={onFoldsChange}
                  onNavigate={onNavigate}
                  onRename={onRenameBookmark}
                  parentKey={rootKey}
                  tree={tree}
                />
              </OutlineActiveContext.Provider>
            </ul>
          )}
        </nav>
        <OverlayScrollbars viewportRef={navRef} />
        <SidebarDropEdge />
      </div>
    </div>
  )
}
