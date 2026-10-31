import { Bookmark } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import type { PdfOutlineItem } from "@/lib/pdf"

type BookmarkListProps = {
  items: PdfOutlineItem[]
  onNavigate: (pageNumber: number) => void
}

type BookmarkItemsProps = BookmarkListProps & {
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
        {/* Beside the sidebar rather than over it: a title too long for a
            column this narrow has nowhere to be read inside it. */}
        <HintTooltip label={title} side="right">
          <button
            className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-left text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:cursor-default disabled:opacity-50"
            disabled={!item.pageNumber}
            onClick={() => item.pageNumber && onNavigate(item.pageNumber)}
            type="button"
          >
            <Bookmark className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{title}</span>
          </button>
        </HintTooltip>
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

export function BookmarkList({ items, onNavigate }: BookmarkListProps) {
  const { t } = useTranslation()

  return (
    <nav className="h-full overflow-auto overscroll-contain p-2" aria-label={t("bookmarks.title")}>
      <ul>
        <BookmarkItems items={items} onNavigate={onNavigate} />
      </ul>
    </nav>
  )
}
