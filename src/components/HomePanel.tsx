import { useEffect, useRef, useState } from "react"
import { Clock, FilePlus2, FolderOpen, LoaderCircle, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import fileSmallIcon from "@/assets/brand/file-small.svg"
import { HintTooltip, HintTooltipGroup } from "@/components/HintTooltip"
import {
  HOME_TAB_ID,
  panelElementId,
  tabElementId,
} from "@/lib/documentTabs"
import type { RecentFile } from "@/lib/recentFiles"

/** Rows rendered before the first scroll, and added per load; the list may
    hold every entry the backend keeps, so it is paged in rather than rendered. */
const RECENT_PAGE_SIZE = 20

const recentActionClass =
  "grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-0"

type HomePanelProps = {
  active: boolean
  onNew: () => void
  onOpenFile: () => void
  onOpenRecent: (path: string) => void
  onRemoveRecent: (path: string) => void
  onRevealRecent: (path: string) => void
  opening: boolean
  recentFiles: RecentFile[]
}

export function HomePanel({
  active,
  onNew,
  onOpenFile,
  onOpenRecent,
  onRemoveRecent,
  onRevealRecent,
  opening,
  recentFiles,
}: HomePanelProps) {
  const { t } = useTranslation()
  const [visibleRecentCount, setVisibleRecentCount] = useState(
    RECENT_PAGE_SIZE,
  )
  const recentListRef = useRef<HTMLUListElement>(null)
  const recentEndRef = useRef<HTMLLIElement>(null)
  const recentTotal = recentFiles.length

  useEffect(() => {
    const sentinel = recentEndRef.current
    const scroller = recentListRef.current

    if (!sentinel || !scroller) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleRecentCount((count) =>
            Math.min(count + RECENT_PAGE_SIZE, recentTotal),
          )
        }
      },
      // Ahead of the list's own scroll view — the page itself stays put — so
      // the next page is usually in before the scroll reaches the list's end.
      { root: scroller, rootMargin: "300px" },
    )
    observer.observe(sentinel)

    return () => observer.disconnect()
  }, [recentTotal])

  const removeRecentLabel = (name: string) => t("home.removeRecent", { name })
  const revealRecentLabel = (name: string) => t("home.revealRecent", { name })

  const visibleRecentFiles = recentFiles.slice(0, visibleRecentCount)
  const moreRecentFiles = visibleRecentCount < recentTotal

  return (
    <div
      aria-hidden={!active}
      aria-labelledby={tabElementId(HOME_TAB_ID)}
      className="app-surface h-svh overflow-hidden"
      data-active={active}
      hidden={!active}
      id={panelElementId(HOME_TAB_ID)}
      role="tabpanel"
    >
      {/* The page itself stays put and the recent list scrolls alone, so the
          welcome and the actions never move under the reader. A margin, not
          padding, keeps this background off the native material the sidebar
          shows through. */}
      <main className="workspace-background ml-(--sidebar-inset) h-full overflow-y-auto p-8 pt-[calc(var(--toolbar-height)+var(--document-tabs-height)+2rem)]">
        <div className="mx-auto flex h-full w-full max-w-4xl flex-col items-center">
          <h1 className="text-2xl font-semibold">{t("home.welcome")}</h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {t("home.tagline")}
          </p>

          {/* `items-start` keeps the action column its own height; the recent
              column stretches to the row's full height so the list has a
              bounded box to scroll inside. The row itself is `minmax(0,1fr)`:
              an auto row would grow to the list's content and push the scroll
              back out to the page. */}
          <div className="mt-8 grid w-full min-h-0 flex-1 grid-cols-[2fr_8fr] grid-rows-[minmax(0,1fr)] items-start gap-6">
            <div className="flex flex-col gap-6">
              <button
                className="group flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border bg-background/75 px-6 py-8 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
                data-slot="new-document"
                disabled={opening}
                onClick={onNew}
                type="button"
              >
                <FilePlus2 className="mb-4 size-10 transition-transform group-hover:-translate-y-0.5" />
                <span className="text-lg font-semibold">{t("home.new")}</span>
                <span className="mt-2 text-sm text-muted-foreground">
                  {t("home.newHint")}
                </span>
              </button>

              <button
                aria-label={t("viewer.chooseFile")}
                className="group flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border bg-background/75 px-6 py-8 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
                data-slot="drop-zone"
                disabled={opening}
                onClick={onOpenFile}
                type="button"
              >
                {opening ? (
                  <LoaderCircle className="mb-4 size-10 animate-spin text-muted-foreground" />
                ) : (
                  <FolderOpen className="mb-4 size-10 transition-transform group-hover:-translate-y-0.5" />
                )}
                <span className="text-lg font-semibold">
                  {opening ? t("viewer.loading") : t("home.open")}
                </span>
                <span className="mt-2 text-sm text-muted-foreground">
                  {t("viewer.dropTitle")}
                </span>
              </button>
            </div>

            <section
              aria-label={t("home.recent")}
              className="flex min-w-0 flex-col self-stretch"
              data-slot="recent-files"
            >
              <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <Clock className="size-3.5" />
                {t("home.recent")}
              </h2>
              {recentFiles.length === 0 ? (
                <p className="mt-3 px-1 text-sm text-muted-foreground">
                  {t("home.recentEmpty")}
                </p>
              ) : (
                // One delay group for every row's actions, so a hint read on
                // one opens the next at once.
                <HintTooltipGroup>
                  <ul
                    className="mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto"
                    ref={recentListRef}
                  >
                    {visibleRecentFiles.map((file) => (
                      <li className="group relative" key={file.path}>
                        <HintTooltip label={file.path}>
                          <button
                            className="peer flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 pr-18 text-left outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                            data-slot="recent-file"
                            disabled={opening}
                            onClick={() => onOpenRecent(file.path)}
                            type="button"
                          >
                            <img alt="" className="size-8 shrink-0" draggable={false} src={fileSmallIcon} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">
                                {file.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {file.directory}
                              </span>
                            </span>
                          </button>
                        </HintTooltip>
                        {/* Siblings of the open button, not children: interactive
                            elements cannot nest. Revealed over its row, by hover
                            or by a keyboard focus anywhere in it — and hidden
                            they take no pointer events, so the space they sit on
                            stays part of the open button's hit area. The focus
                            is the open button's as the `peer`, or one of their
                            own: `group-has-*` costs Chromium a restyle of the
                            whole document for every node added anywhere. */}
                        <div className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 peer-focus-visible:pointer-events-auto peer-focus-visible:opacity-100 has-focus-visible:pointer-events-auto has-focus-visible:opacity-100">
                          <HintTooltip
                            inDelayGroup
                            label={revealRecentLabel(file.name)}
                          >
                            <button
                              aria-label={revealRecentLabel(file.name)}
                              className={recentActionClass}
                              data-slot="reveal-recent-file"
                              disabled={opening}
                              onClick={() => onRevealRecent(file.path)}
                              type="button"
                            >
                              <FolderOpen className="size-4" />
                            </button>
                          </HintTooltip>
                          <HintTooltip
                            inDelayGroup
                            label={removeRecentLabel(file.name)}
                          >
                            <button
                              aria-label={removeRecentLabel(file.name)}
                              className={recentActionClass}
                              data-slot="remove-recent-file"
                              disabled={opening}
                              onClick={() => onRemoveRecent(file.path)}
                              type="button"
                            >
                              <X className="size-4" />
                            </button>
                          </HintTooltip>
                        </div>
                      </li>
                    ))}
                    {moreRecentFiles ? (
                      <li aria-hidden className="h-px" ref={recentEndRef} />
                    ) : null}
                  </ul>
                </HintTooltipGroup>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
