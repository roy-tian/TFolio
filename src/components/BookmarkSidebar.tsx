import { Bookmark, ListTree } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { PdfOutlineItem } from "@/lib/pdf"

type BookmarkSidebarProps = {
  items: PdfOutlineItem[]
  onNavigate: (pageNumber: number) => void
}

type BookmarkItemsProps = BookmarkSidebarProps & {
  parentKey?: string
}

function BookmarkItems({
  items,
  onNavigate,
  parentKey = "root",
}: BookmarkItemsProps) {
  const { t } = useTranslation()

  return items.map((item, index) => {
    const itemKey = `${parentKey}-${index}`
    const title = item.title.trim() || t("bookmarks.untitled")

    return (
      <li key={itemKey}>
        <button
          className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-50"
          disabled={!item.pageNumber}
          onClick={() => item.pageNumber && onNavigate(item.pageNumber)}
          title={title}
          type="button"
        >
          <Bookmark className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{title}</span>
        </button>
        {item.items.length ? (
          <ul className="pl-3">
            <BookmarkItems
              items={item.items}
              onNavigate={onNavigate}
              parentKey={itemKey}
            />
          </ul>
        ) : null}
      </li>
    )
  })
}

export function BookmarkSidebar({
  items,
  onNavigate,
}: BookmarkSidebarProps) {
  const { t } = useTranslation()

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3 text-sm font-medium">
        <ListTree className="size-4 text-muted-foreground" />
        {t("bookmarks.title")}
      </div>
      <nav className="min-h-0 flex-1 overflow-auto p-2" aria-label={t("bookmarks.title")}>
        {items.length ? (
          <ul>
            <BookmarkItems
              items={items}
              onNavigate={onNavigate}
            />
          </ul>
        ) : (
          <p className="px-2 py-5 text-center text-xs leading-5 text-muted-foreground">
            {t("bookmarks.empty")}
          </p>
        )}
      </nav>
    </aside>
  )
}
