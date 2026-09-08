import { useEffect, useRef } from "react"
import {
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Search,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export type PdfSearchProps = {
  activeIndex: number | null
  failed: boolean
  limitReached: boolean
  matchCount: number
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
  onQueryChange: (query: string) => void
  query: string
  searching: boolean
}

/** The app-owned find bar. It floats over the document below the title and tab
    bars, so it remains part of TFolio instead of opening the WebView's native
    page search (which would also search tabs and toolbar labels). */
export function PdfSearch({
  activeIndex,
  failed,
  limitReached,
  matchCount,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
  query,
  searching,
}: PdfSearchProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const hasQuery = query.trim().length > 0
  const canNavigate = !searching && matchCount > 0

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })

    return () => cancelAnimationFrame(frame)
  }, [])

  const status = searching
    ? t("search.searching")
    : failed
      ? t("search.failed")
      : !hasQuery
        ? ""
        : matchCount === 0 || activeIndex === null
          ? t("search.noResults")
          : t(
              limitReached
                ? "search.resultStatusMore"
                : "search.resultStatus",
              {
                current: activeIndex + 1,
                total: matchCount,
              },
            )

  return (
    <div
      aria-label={t("search.title")}
      className="fixed top-22 right-3 z-50 flex h-10 w-88 max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-lg border bg-background p-1 shadow-lg"
      data-slot="pdf-search"
      role="search"
    >
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("search.input")}
          className="h-8 border-0 bg-transparent pr-2 pl-8 shadow-none focus-visible:ring-0 dark:bg-transparent"
          maxLength={256}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return
            }

            if (event.key === "Escape") {
              event.preventDefault()
              onClose()
            } else if (event.key === "Enter" && canNavigate) {
              event.preventDefault()
              if (event.shiftKey) {
                onPrevious()
              } else {
                onNext()
              }
            }
          }}
          placeholder={t("search.placeholder")}
          ref={inputRef}
          type="search"
          value={query}
        />
      </div>

      <span
        aria-live="polite"
        className="flex min-w-15 shrink-0 items-center justify-center whitespace-nowrap text-xs text-muted-foreground"
        data-slot="pdf-search-status"
      >
        {searching ? <LoaderCircle className="size-3.5 animate-spin" /> : status}
        {searching ? <span className="sr-only">{status}</span> : null}
      </span>

      <ToolbarTooltip label={t("search.previous")}>
        <Button
          aria-label={t("search.previous")}
          disabled={!canNavigate}
          onClick={onPrevious}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronUp />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={t("search.next")}>
        <Button
          aria-label={t("search.next")}
          disabled={!canNavigate}
          onClick={onNext}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronDown />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={t("search.close")}>
        <Button
          aria-label={t("search.close")}
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <X />
        </Button>
      </ToolbarTooltip>
    </div>
  )
}
