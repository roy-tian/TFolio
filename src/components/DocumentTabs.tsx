import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, ExternalLink, FolderOpen, House, LoaderCircle, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import fileTinyIcon from "@/assets/brand/file-tiny.svg"
import { HintTooltip, HintTooltipGroup } from "@/components/HintTooltip"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { useListDrag, type ListDragState } from "@/hooks/useListDrag"
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

/** A dragged tab's ghost stays in sight at the window's edge, where the
    pointer has gone past it: the drag is still this window's to answer. */
const GHOST_EDGE_MARGIN = 4

type DocumentTabsProps = {
  activeId: TabId
  /** The tab a page drag is resting on, which the workspace is about to open
      under it — see `usePageHandoff`. The bar beneath counts the rest out. */
  armedTabId: number | null
  onActivate: (tabId: TabId) => void
  onClose: (documentId: number) => void
  onOpenFile: () => void
  /** Reorders the document tabs, both indices among them; home stays first. */
  onReorder: (from: number, to: number) => void
  /** A release the strip did not keep: the workspace owns where the tab goes —
      another window, or a new one of its own. */
  onTabDropOutside?: (documentId: number, point: { x: number; y: number }) => void
  /** Follows a drag that has left the strip by the dragged tab's name, so the
      windows it passes over can say so; a null name reports the drag over
      wherever it went. */
  onTabDragMove?: (name: string | null, point: { x: number; y: number }) => void
  /** The context menu's ask: the tab becomes a window of its own. */
  onMoveToNewWindow?: (documentId: number) => void
  opening: boolean
  tabs: DocumentTabItem[]
}

// Document tabs pull `mb-[-1px]` over the strip's border so the selected one
// melts into the white panel below it; see the home tab for the exception.
const tabClassName =
  "group/tab relative flex h-8 items-center rounded-t-md border border-b-0"

/** The tab in hand, portalled above the strip and its clipped scroller so it
    follows the pointer past either edge. */
function TabDragGhost({ drag, tab }: {
  drag: ListDragState
  tab: DocumentTabItem
}) {
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-60 flex select-none items-center gap-1.5 rounded-md border bg-background px-3 text-sm text-foreground shadow-lg"
      data-slot="tab-drag-ghost"
      style={{
        height: drag.height,
        left: Math.min(
          Math.max(drag.pointer.x + drag.grip.x, GHOST_EDGE_MARGIN),
          window.innerWidth - drag.width - GHOST_EDGE_MARGIN,
        ),
        top: Math.min(
          Math.max(drag.pointer.y + drag.grip.y, GHOST_EDGE_MARGIN),
          window.innerHeight - drag.height - GHOST_EDGE_MARGIN,
        ),
        width: drag.width,
      }}
    >
      <img alt="" className="size-4 shrink-0" draggable={false} src={fileTinyIcon} />
      {tab.dirty ? (
        <span className="size-2 shrink-0 rounded-full bg-primary" />
      ) : null}
      <span className="truncate">{tab.name}</span>
    </div>,
    document.body,
  )
}

export function DocumentTabs({
  activeId,
  armedTabId,
  onActivate,
  onClose,
  onOpenFile,
  onReorder,
  onTabDropOutside,
  onTabDragMove,
  onMoveToNewWindow,
  opening,
  tabs,
}: DocumentTabsProps) {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  const tabIds: TabId[] = [HOME_TAB_ID, ...tabs.map((tab) => tab.id)]
  const reorderable = tabs.length > 1
  // The strip's handle is the tab itself; only its close button is pressed.
  const { drag } = useListDrag({
    active: reorderable,
    axis: "x",
    listRef: scrollerRef,
    onReorder,
    onDropOutside: onTabDropOutside
      ? (point, index) => {
          const tab = tabs[index]

          if (tab) {
            onTabDropOutside(tab.id, point)
          }
        }
      : undefined,
    // The strip, not the scroller, bounds the drop: its trailing spacer and
    // the actions beside the list read as strip rather than as out.
    dropAreaRef: stripRef,
    pressOnly: (target) => target.closest("[data-tab-close]") !== null,
  })
  // A finished drag ends in a click-shaped burst on the tab it lifted, which
  // must not read as an activation — for that one tab only, so a pressless
  // click (WebDriver's) on any other still activates. The next real press,
  // anywhere, ends the drag's claim outright.
  const draggedClickRef = useRef<number | null>(null)

  useEffect(() => {
    if (drag) {
      draggedClickRef.current = tabs[drag.index]?.id ?? null
    }
  }, [drag, tabs])

  useEffect(() => {
    const clearDraggedClick = () => {
      draggedClickRef.current = null
    }

    document.addEventListener("pointerdown", clearDraggedClick, true)
    return () =>
      document.removeEventListener("pointerdown", clearDraggedClick, true)
  }, [])

  const draggedTab = drag ? tabs[drag.index] : undefined

  // Where the drag has gone is the workspace's to answer for: it owns the
  // other windows the tab could land on and the highlighting they show. Only
  // the moves that leave the strip are worth a word, and the drag's end is.
  const dragOutside = drag?.outside ? drag.pointer : null
  const reportedDragRef = useRef(false)

  useEffect(() => {
    if (dragOutside && draggedTab) {
      reportedDragRef.current = true
      onTabDragMove?.(draggedTab.name, dragOutside)
    } else if (reportedDragRef.current) {
      reportedDragRef.current = false
      onTabDragMove?.(null, { x: 0, y: 0 })
    }
  }, [dragOutside, draggedTab, onTabDragMove])

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
      ref={stripRef}
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
            // No overlap here, unlike document tabs: below the strip lies the
            // home tab's zinc backdrop, and the selected tab eating the border
            // row would leave a stray white pixel line under itself.
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
          <HintTooltipGroup>
            {tabs.map((tab, index) => {
              const selected = tab.id === activeId
              const armed = tab.id === armedTabId
              // A selected tab is parted from its neighbours by its own border;
              // between two unselected ones nothing marks where one ends.
              const previousId: TabId = tabs[index - 1]?.id ?? HOME_TAB_ID
              const divided = !selected && previousId !== activeId
              const wayOffset = drag?.cellOffsets[index] ?? 0

              return (
                <ContextMenu key={tab.id}>
                  {/* A tab is its own menu trigger: the entries below act on
                      this tab alone, and no other surface here has any. */}
                  <ContextMenuTrigger
                    render={
                      <div
                        className={cn(
                          tabClassName,
                          "mb-[-1px] w-44 min-w-28 max-w-56",
                          selected
                            ? "bg-background text-foreground"
                            : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground",
                          divided &&
                            "before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-border",
                          // Held pages are over this tab: it reads as the one they are
                          // about to be taken to, ahead of it actually opening.
                          armed && "border-primary bg-background text-foreground",
                          drag &&
                            drag.index !== index &&
                            "transition-transform duration-200 ease-out",
                          // The portal ghost carries this tab; the real one stays as
                          // the hole the others slide around to fill.
                          drag?.index === index && "opacity-0",
                        )}
                        data-document-tab={tab.id}
                        data-list-index={index}
                        style={{
                          transform:
                            wayOffset === 0
                              ? undefined
                              : `translateX(${wayOffset}px)`,
                        }}
                      />
                    }
                  >
                  {/* The workspace puts focus on this button after every open,
                      and a hint opened by that would stand over the strip. */}
                  <HintTooltip inDelayGroup label={tab.name} openOnFocus={false}>
                    <button
                      aria-controls={panelElementId(tab.id)}
                      aria-selected={selected}
                      className={cn(
                        "flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        reorderable && "cursor-grab",
                      )}
                      id={tabElementId(tab.id)}
                      onClick={(event) => {
                        if (draggedClickRef.current === tab.id) {
                          draggedClickRef.current = null
                          return
                        }

                        // Starting a drag cancels the press's native focus, so
                        // the click that survives puts it back itself.
                        event.currentTarget.focus()
                        onActivate(tab.id)
                      }}
                      onKeyDown={(event) => handleKeyDown(event, tab.id)}
                      role="tab"
                      tabIndex={selected ? 0 : -1}
                      type="button"
                    >
                      <img alt="" className="size-4 shrink-0" draggable={false} src={fileTinyIcon} />
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
                      data-tab-close
                      onClick={() => onClose(tab.id)}
                      tabIndex={selected ? 0 : -1}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  </HintTooltip>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      data-action="tab-move-new-window"
                      onClick={() => onMoveToNewWindow?.(tab.id)}
                    >
                      <ExternalLink />
                      {t("tabs.moveToNewWindow")}
                    </ContextMenuItem>
                    <ContextMenuItem
                      data-action="tab-close"
                      onClick={() => onClose(tab.id)}
                    >
                      <X />
                      {t("tabs.close", { name: tab.name })}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              )
            })}
          </HintTooltipGroup>
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
                <img alt="" className="size-4 shrink-0" draggable={false} src={fileTinyIcon} />
                <span className="min-w-0 flex-1 truncate">{tab.name}</span>
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

      {drag && draggedTab ? <TabDragGhost drag={drag} tab={draggedTab} /> : null}
    </div>
  )
}
