import { useRef } from "react"
import { Bookmark, ChevronRight } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { OutlineBar } from "@/components/SidebarPanelTools"
import {
  bookmarkFoldKey,
  DOCUMENT_OUTLINE_KEY,
  foldableBookmarks,
  foldAllOf,
  nestsBookmarks,
  toggledFold,
  type OutlineFolds,
} from "@/lib/outlineFolds"
import type { PdfOutlineItem } from "@/lib/pdf"
import { cn } from "@/lib/utils"

type BookmarkItemsProps = {
  folds: OutlineFolds
  items: PdfOutlineItem[]
  onFoldsChange: (folds: OutlineFolds) => void
  onNavigate: (pageNumber: number) => void
  parentKey: string
  /** Whether the outline nests at all: a flat one keeps no room for arrows. */
  tree: boolean
}

/** The `li`s of one level, for a `ul` the caller owns. */
export function BookmarkItems({
  folds,
  items,
  onFoldsChange,
  onNavigate,
  parentKey,
  tree,
}: BookmarkItemsProps) {
  const { t } = useTranslation()

  return items.map((item, index) => {
    const itemKey = bookmarkFoldKey(parentKey, index)
    const title = item.title.trim() || t("bookmarks.untitled")
    const nested = item.items.length > 0
    const open = nested && !folds.has(itemKey)

    return (
      <li key={itemKey}>
        <div
          className={cn(
            "flex items-center rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            tree && "gap-1",
          )}
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
                <ChevronRight
                  className={cn("size-3.5 transition-transform", open && "rotate-90")}
                />
              </button>
            ) : (
              <span aria-hidden className="size-6 shrink-0" />
            )
          ) : null}
          {/* Beside the sidebar rather than over it: a title too long for a
              column this narrow has nowhere to be read inside it. */}
          <HintTooltip label={title} side="right">
            <button
              className={cn(
                "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-50",
                !tree && "pl-2",
              )}
              disabled={!item.pageNumber}
              onClick={() => item.pageNumber && onNavigate(item.pageNumber)}
              type="button"
            >
              <Bookmark className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{title}</span>
            </button>
          </HintTooltip>
        </div>
        {open ? (
          <ul className="pl-5">
            <BookmarkItems
              folds={folds}
              items={item.items}
              onFoldsChange={onFoldsChange}
              onNavigate={onNavigate}
              parentKey={itemKey}
              tree
            />
          </ul>
        ) : null}
      </li>
    )
  })
}

type BookmarkListProps = {
  folds: OutlineFolds
  items: PdfOutlineItem[]
  onFoldsChange: (folds: OutlineFolds) => void
  onNavigate: (pageNumber: number) => void
  /** Whose bookmarks these are, as fold keys: the document's, or one file's. */
  rootKey?: string
}

export function BookmarkList({
  folds,
  items,
  onFoldsChange,
  onNavigate,
  rootKey = DOCUMENT_OUTLINE_KEY,
}: BookmarkListProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)
  const foldAll = foldAllOf(
    folds,
    items.flatMap((item, index) =>
      item.items.length > 0 ? [bookmarkFoldKey(rootKey, index)] : [],
    ),
    foldableBookmarks(items, rootKey),
  )

  return (
    <div className="flex h-full flex-col">
      <OutlineBar
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
          {items.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{t("sidebar.noBookmarks")}</p>
          ) : (
            <ul>
              <BookmarkItems
                folds={folds}
                items={items}
                onFoldsChange={onFoldsChange}
                onNavigate={onNavigate}
                parentKey={rootKey}
                tree={nestsBookmarks(items)}
              />
            </ul>
          )}
        </nav>
        <OverlayScrollbars viewportRef={navRef} />
      </div>
    </div>
  )
}
