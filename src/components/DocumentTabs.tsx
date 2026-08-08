import { X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { tabIdForKey } from "@/lib/documentTabs"
import { cn } from "@/lib/utils"

export type DocumentTabItem = {
  dirty: boolean
  id: number
  name: string
}

type DocumentTabsProps = {
  activeId: number
  onActivate: (documentId: number) => void
  onClose: (documentId: number) => void
  tabs: DocumentTabItem[]
}

export function DocumentTabs({
  activeId,
  onActivate,
  onClose,
  tabs,
}: DocumentTabsProps) {
  const { t } = useTranslation()
  const tabIds = tabs.map((tab) => tab.id)

  const handleKeyDown = (event: React.KeyboardEvent, documentId: number) => {
    const targetId = tabIdForKey(tabIds, documentId, event.key)

    if (targetId === null) {
      return
    }

    event.preventDefault()
    onActivate(targetId)
    requestAnimationFrame(() => {
      document.getElementById(`document-tab-${targetId}`)?.focus()
    })
  }

  return (
    <div
      aria-label={t("tabs.list")}
      className="fixed inset-x-0 top-12 z-40 flex h-9 items-end overflow-x-auto border-b bg-muted/70 px-2 backdrop-blur"
      role="tablist"
    >
      {tabs.map((tab) => {
        const selected = tab.id === activeId

        return (
          <div
            className={cn(
              "group/tab mb-[-1px] flex h-8 min-w-36 max-w-56 shrink-0 items-center rounded-t-md border border-b-0",
              selected
                ? "bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
            )}
            key={tab.id}
          >
            <button
              aria-controls={`document-panel-${tab.id}`}
              aria-selected={selected}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              id={`document-tab-${tab.id}`}
              onClick={() => onActivate(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, tab.id)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              title={tab.name}
              type="button"
            >
              {tab.dirty ? (
                <span
                  aria-label={t("tabs.unsaved")}
                  className="size-2 shrink-0 rounded-full bg-primary"
                />
              ) : null}
              <span className="truncate">{tab.name}</span>
            </button>
            <button
              aria-label={t("tabs.close", { name: tab.name })}
              className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onClose(tab.id)}
              tabIndex={selected ? 0 : -1}
              title={t("tabs.close", { name: tab.name })}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
      <div
        className="min-w-8 flex-1 self-stretch"
        data-tauri-drag-region="deep"
      />
    </div>
  )
}
