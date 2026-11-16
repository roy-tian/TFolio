import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { SidebarDropHint } from "@/components/SidebarFileDrop"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { useSidebarDrop } from "@/hooks/useSidebarDrop"
import { cn } from "@/lib/utils"

export type FoldAll = {
  /** Something shown could be folded away. */
  canFold: boolean
  /** Something is folded. */
  canUnfold: boolean
  foldLabel: string
  onFold: (folded: boolean) => void
  unfoldLabel: string
}

type SidebarPanelToolsProps = {
  /** A panel's own tools, before the fold buttons, which then end the bar at
      the same place over either panel. */
  children?: ReactNode
  fold: FoldAll
}

/** The end of each sidebar panel's bar, the same over the pages and the
    outline: folding everything there is to fold, and unfolding it all. */
export function SidebarPanelTools({ children, fold }: SidebarPanelToolsProps) {
  const { t } = useTranslation()
  // Greyed, each says why: nothing to fold, all folded, or nothing folded.
  const foldLabel = fold.canFold
    ? fold.foldLabel
    : fold.canUnfold
      ? t("sidebar.allFolded")
      : t("sidebar.nothingToFold")
  const unfoldLabel = fold.canUnfold ? fold.unfoldLabel : t("sidebar.nothingFolded")

  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      {children}
      <ToolbarTooltip label={foldLabel}>
        <Button
          aria-label={fold.foldLabel}
          data-slot="sidebar-fold-all"
          disabled={!fold.canFold}
          onClick={() => fold.onFold(true)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronsDownUp />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={unfoldLabel}>
        <Button
          aria-label={fold.unfoldLabel}
          data-slot="sidebar-unfold-all"
          disabled={!fold.canUnfold}
          onClick={() => fold.onFold(false)}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronsUpDown />
        </Button>
      </ToolbarTooltip>
    </div>
  )
}

/** The bar over the outline, as `PagesBar` stands over the pages. */
export function OutlineBar(props: SidebarPanelToolsProps) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b px-2" data-slot="outline-bar">
      <SidebarPanelTools {...props} />
    </div>
  )
}

/** In words, under either panel: an icon among the fold buttons was taken
    for one of them. While a file drag offers the sidebar, the words say what
    a drop does instead: down here they cover neither the bars' buttons nor
    the first file's name. */
export function AddFilesButton({ dropLabel, onClick }: { dropLabel: string; onClick: () => void }) {
  const { t } = useTranslation()
  const drop = useSidebarDrop()

  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <SidebarDropHint label={dropLabel} />
      <Button
        className={cn("min-w-0 shrink", drop && "invisible")}
        data-slot="sidebar-add-files"
        onClick={onClick}
        size="sm"
        variant="ghost"
      >
        <Plus />
        <span className="truncate">{t("sidebar.addFiles")}</span>
      </Button>
    </div>
  )
}
