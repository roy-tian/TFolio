import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react"
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
  fold: FoldAll
}

/** The end of each sidebar panel's bar, the same over the pages and the
    outline: folding everything there is to fold, and unfolding it all. */
export function SidebarPanelTools({ fold }: SidebarPanelToolsProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <ToolbarTooltip label={fold.foldLabel}>
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
      <ToolbarTooltip label={fold.unfoldLabel}>
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

/** The bar over the outline, as `PagesBar` stands over the pages, saying
    while a file drag offers the sidebar what a drop there does. */
export function OutlineBar({
  dropLabel,
  ...props
}: SidebarPanelToolsProps & { dropLabel: string }) {
  const drop = useSidebarDrop()

  return (
    <div className="relative flex h-9 shrink-0 items-center border-b px-2" data-slot="outline-bar">
      <SidebarDropHint label={dropLabel} />
      {/* Hidden, not unmounted, as the pages bar's are. */}
      <div className={cn("flex min-w-0 flex-1 items-center", drop && "invisible")}>
        <SidebarPanelTools {...props} />
      </div>
    </div>
  )
}

/** In words, under either panel: an icon among the fold buttons was taken
    for one of them. */
export function AddFilesButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()

  return (
    <Button
      className="min-w-0 shrink"
      data-slot="sidebar-add-files"
      onClick={onClick}
      size="sm"
      variant="ghost"
    >
      <Plus />
      <span className="truncate">{t("sidebar.addFiles")}</span>
    </Button>
  )
}
