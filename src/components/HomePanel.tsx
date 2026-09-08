import { Clock, FileText, FileUp, LoaderCircle } from "lucide-react"
import { useTranslation } from "react-i18next"

import { DismissibleAlert } from "@/components/DismissibleAlert"
import { HintTooltip } from "@/components/HintTooltip"
import {
  HOME_TAB_ID,
  panelElementId,
  tabElementId,
} from "@/lib/documentTabs"
import type { RecentFile } from "@/lib/recentFiles"

type HomePanelProps = {
  active: boolean
  errorKey: number
  errorMessage: string | null
  onDismissError: () => void
  onOpenFile: () => void
  onOpenRecent: (path: string) => void
  opening: boolean
  recentFiles: RecentFile[]
}

export function HomePanel({
  active,
  errorKey,
  errorMessage,
  onDismissError,
  onOpenFile,
  onOpenRecent,
  opening,
  recentFiles,
}: HomePanelProps) {
  const { t } = useTranslation()

  return (
    <div
      aria-hidden={!active}
      aria-labelledby={tabElementId(HOME_TAB_ID)}
      className="h-svh overflow-hidden bg-background"
      data-active={active}
      hidden={!active}
      id={panelElementId(HOME_TAB_ID)}
      role="tabpanel"
    >
      <main className="h-full overflow-auto bg-zinc-200/70 p-8 pt-29 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center">
          <h1 className="text-2xl font-semibold">{t("home.welcome")}</h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {t("about.description")}
          </p>

          <div className="mt-8 grid w-full gap-6 sm:grid-cols-2 sm:items-start">
            <div className="flex flex-col">
              {/* A height of its own, rather than the grid row's: otherwise the
                  drop target grows with the recent list beside it and shrinks
                  again when an error message appears under it. */}
              <button
                aria-label={t("viewer.chooseFile")}
                className="group flex min-h-72 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-400 bg-background/75 px-8 py-12 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
                data-slot="drop-zone"
                disabled={opening}
                onClick={onOpenFile}
                type="button"
              >
                {opening ? (
                  <LoaderCircle className="mb-5 size-10 animate-spin text-muted-foreground" />
                ) : (
                  <FileUp className="mb-5 size-10 text-muted-foreground transition-transform group-hover:-translate-y-0.5" />
                )}
                <span className="text-lg font-semibold">
                  {opening ? t("viewer.loading") : t("viewer.dropTitle")}
                </span>
                <span className="mt-2 text-sm text-muted-foreground">
                  {t("viewer.dropDescription")}
                </span>
              </button>

              {errorMessage ? (
                <DismissibleAlert
                  className="mt-4 self-center text-sm text-destructive"
                  dismissKey={errorKey}
                  onDismiss={onDismissError}
                >
                  {errorMessage}
                </DismissibleAlert>
              ) : null}
            </div>

            <section
              aria-label={t("home.recent")}
              className="min-w-0"
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
                <ul className="mt-2 flex flex-col">
                  {recentFiles.map((file) => (
                    <li key={file.path}>
                      <HintTooltip label={file.path}>
                        <button
                          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                          data-slot="recent-file"
                          disabled={opening}
                          onClick={() => onOpenRecent(file.path)}
                          type="button"
                        >
                          <FileText className="size-4 shrink-0 text-muted-foreground" />
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
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
