import { useTranslation } from "react-i18next"

import { PageNumberField } from "@/components/PageNumberField"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"

type PageStatusProps = {
  currentPage: CurrentPage
  onSubmit: (value: string) => void
  pageCount: number
}

/** The one part of the status bar that follows scrolling, so the only part
    that re-renders as the reader crosses into another page. */
export function PageStatus({ currentPage, onSubmit, pageCount }: PageStatusProps) {
  const { t } = useTranslation()
  const current = useCurrentPage(currentPage)
  const status = t("statusBar.pageStatus", { current, total: pageCount })

  return (
    <div
      aria-label={status}
      className="flex items-center gap-1.5 font-mono text-sm tabular-nums"
      data-slot="page-status"
      role="group"
    >
      <PageNumberField
        currentPage={current}
        onSubmit={onSubmit}
      />
      <span className="text-muted-foreground">/</span>
      <span>{pageCount}</span>
      <span aria-live="polite" className="sr-only">
        {status}
      </span>
    </div>
  )
}
