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
  /** A panel's own tools, before the fold button, which then ends the bar at
      the same place over either panel. */
  children?: ReactNode
  fold: FoldAll
}

/** The end of each sidebar panel's bar, the same over the pages and the
    outline: one button folding everything there is to fold, and unfolding it
    all once nothing shown is left to fold. */
export function SidebarPanelTools({ children, fold }: SidebarPanelToolsProps) {
  const { t } = useTranslation()
  const folds = fold.canFold || !fold.canUnfold
  const label = folds ? fold.foldLabel : fold.unfoldLabel

  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      {children}
      <ToolbarTooltip label={fold.canFold || fold.canUnfold ? label : t("sidebar.nothingToFold")}>
        <Button
          aria-label={label}
          data-slot="sidebar-fold-all"
          disabled={!fold.canFold && !fold.canUnfold}
          onClick={() => fold.onFold(folds)}
          size="icon-sm"
          variant="ghost"
        >
          {folds ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
      </ToolbarTooltip>
    </div>
  )
}

/** The bar over the outline, as `PagesBar` stands over the pages. */
export function OutlineBar({
  add,
  children,
  fold,
}: SidebarPanelToolsProps & {
  add?: { active?: boolean; label: string; onAdd: () => void }
}) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b px-2" data-slot="outline-bar">
      <SidebarPanelTools fold={fold}>
        {add ? (
          <ToolbarTooltip label={add.label}>
            <Button
              aria-label={add.label}
              data-slot="sidebar-add-bookmark"
              onClick={add.onAdd}
              // Keep focus in an active draft input if `+` is pressed again.
              onPointerDown={add.active ? (event) => event.preventDefault() : undefined}
              size="icon-sm"
              variant="ghost"
            >
              <Plus />
            </Button>
          </ToolbarTooltip>
        ) : null}
        {children}
      </SidebarPanelTools>
    </div>
  )
}

/** In words, under either panel: an icon in the bars was taken for a fold
    button. While a file drag offers the sidebar, the words say what
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
