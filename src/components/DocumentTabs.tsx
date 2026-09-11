import { useEffect, useRef, useState } from "react"
import { ChevronDown, FolderOpen, House, LoaderCircle, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  HOME_TAB_ID,
  panelElementId,
  tabElementId,
  tabIdForKey,
  type TabId,
} from "@/lib/documentTabs"
import { TAB_SPRING_MS } from "@/lib/pageDrag"
import { shortcuts } from "@/lib/shortcuts"
import { cn } from "@/lib/utils"

export type DocumentTabItem = {
  dirty: boolean
  id: number
  name: string
}

type DocumentTabsProps = {
  activeId: TabId
  /** The tab a page drag is resting on, which the workspace is about to open
      under it — see `usePageHandoff`. The bar beneath counts the rest out. */
  armedTabId: number | null
  onActivate: (tabId: TabId) => void
  onClose: (documentId: number) => void
  onOpenFile: () => void
  opening: boolean
  tabs: DocumentTabItem[]
}

const tabClassName =
  "group/tab relative mb-[-1px] flex h-8 items-center rounded-t-md border border-b-0"

export function DocumentTabs({
  activeId,
  armedTabId,
  onActivate,
  onClose,
  onOpenFile,
  opening,
  tabs,
}: DocumentTabsProps) {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  const tabIds: TabId[] = [HOME_TAB_ID, ...tabs.map((tab) => tab.id)]

  useEffect(() => {
    const scroller = scrollerRef.current

    if (!scroller) {
      return
    }

    const measure = () => {
      setScrolls(scroller.scrollWidth - scroller.clientWidth > 1)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(scroller)

    return () => observer.disconnect()
  }, [tabs.length])

  // Also when `scrolls` flips: the menu button appearing takes its width off
  // the strip, which would otherwise clip the tab just scrolled into view.
  useEffect(() => {
    document.getElementById(tabElementId(activeId))?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  }, [activeId, scrolls, tabs.length])

  const handleKeyDown = (event: React.KeyboardEvent, tabId: TabId) => {
    const targetId = tabIdForKey(tabIds, tabId, event.key)

    if (targetId === null) {
      return
    }

    event.preventDefault()
    onActivate(targetId)
    requestAnimationFrame(() => {
      document.getElementById(tabElementId(targetId))?.focus()
    })
  }

  const homeSelected = activeId === HOME_TAB_ID

  return (
    // The whole strip is the workspace's, which `data-tab-strip` is what a page
    // drag hit-tests for: a release on it lands nothing rather than reordering.
    <div
      className="fixed inset-x-0 top-12 z-40 flex h-9 items-end gap-1 border-b bg-muted/70 px-2 backdrop-blur"
      data-tab-strip
    >
      {/* The open and list actions sit outside the tablist: they are not tabs,
          and arrow-key tab navigation must not land on them. */}
      <div
        aria-label={t("tabs.list")}
        className="flex h-full min-w-0 items-end"
        role="tablist"
      >
        <button
          aria-controls={panelElementId(HOME_TAB_ID)}
          aria-selected={homeSelected}
          className={cn(
            tabClassName,
            "shrink-0 gap-1.5 px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            homeSelected
              ? "bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
          )}
          id={tabElementId(HOME_TAB_ID)}
          onClick={() => onActivate(HOME_TAB_ID)}
          onKeyDown={(event) => handleKeyDown(event, HOME_TAB_ID)}
          role="tab"
          tabIndex={homeSelected ? 0 : -1}
          type="button"
        >
          <House className="size-4" />
          <span>{t("tabs.home")}</span>
        </button>

        {/* `overflow-x` alone promotes the other axis to `auto`, and each tab's
            `mb-[-1px]` is then overflow enough for a scrollbar to appear. */}
        <div
          className="flex h-full min-w-0 items-end overflow-x-auto overflow-y-hidden"
          ref={scrollerRef}
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === activeId
            const armed = tab.id === armedTabId
            // A selected tab is parted from its neighbours by its own border;
            // between two unselected ones nothing marks where one ends.
            const previousId: TabId = tabs[index - 1]?.id ?? HOME_TAB_ID
            const divided = !selected && previousId !== activeId

            return (
              <div
                className={cn(
                  tabClassName,
                  "w-44 min-w-28 max-w-56",
                  selected
                    ? "bg-background text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
                  divided &&
                    "before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-border",
                  // Held pages are over this tab: it reads as the one they are
                  // about to be taken to, ahead of it actually opening.
                  armed && "border-primary bg-background text-foreground",
                )}
                data-document-tab={tab.id}
                key={tab.id}
              >
                {/* The workspace puts focus on this button after every open,
                    and a hint opened by that would stand over the strip. */}
                <HintTooltip label={tab.name} openOnFocus={false}>
                  <button
                    aria-controls={panelElementId(tab.id)}
                    aria-selected={selected}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    id={tabElementId(tab.id)}
                    onClick={() => onActivate(tab.id)}
                    onKeyDown={(event) => handleKeyDown(event, tab.id)}
                    role="tab"
                    tabIndex={selected ? 0 : -1}
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
                </HintTooltip>
                {/* Runs the length of the wait the tab is about to end: the
                    dwell itself, so the bar cannot promise a different one. */}
                {armed ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-1 bottom-1 h-1 origin-left rounded-full animate-tab-spring bg-primary"
                    style={{ animationDuration: `${TAB_SPRING_MS}ms` }}
                  />
                ) : null}
                <HintTooltip label={t("tabs.close", { name: tab.name })}>
                  <button
                    aria-label={t("tabs.close", { name: tab.name })}
                    className="mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onClose(tab.id)}
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                </HintTooltip>
              </div>
            )
          })}
        </div>
      </div>

      <ToolbarTooltip
        label={t("tabs.openFile")}
        shortcut={shortcuts.open}
        side="top"
      >
        <Button
          aria-label={t("tabs.openFile")}
          className="mb-0.5 shrink-0"
          data-slot="tab-open-file"
          disabled={opening}
          onClick={onOpenFile}
          size="icon-sm"
          variant="ghost"
        >
          {opening ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
        </Button>
      </ToolbarTooltip>

      {scrolls ? (
        <DropdownMenu>
          <ToolbarTooltip label={t("tabs.listAll")} side="top">
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={t("tabs.listAll")}
                  className="mb-0.5 shrink-0"
                  data-slot="tab-overflow-menu"
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
          </ToolbarTooltip>
          <DropdownMenuContent align="end" className="w-64">
            {tabs.map((tab) => (
              <DropdownMenuItem
                className={cn(
                  "justify-between gap-2",
                  tab.id === activeId && "bg-accent/60",
                )}
                key={tab.id}
                onClick={() => onActivate(tab.id)}
              >
                <span className="truncate">{tab.name}</span>
                {tab.dirty ? (
                  <span
                    aria-label={t("tabs.unsaved")}
                    className="size-2 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <div
        className="h-full min-w-8 flex-1 self-stretch"
        data-tauri-drag-region="deep"
      />
    </div>
  )
}
