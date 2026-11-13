import { RotateCcw, RotateCw, Trash2, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip, HintTooltipGroup } from "@/components/HintTooltip"
import { PAPER_CONTROLS_SHOWN } from "@/components/PdfThumbnail"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

/** A press or a click on a page's own controls is theirs: no drag, no choice
    of page, and an insertion gap's empty white is not the page beside it. */
export const PAGE_CONTROL = "[data-page-control]"

export type PageAction = "rotate-left" | "rotate-right" | "delete"

/** A page's checkbox, in its paper's top left corner: shown under the pointer,
    and while it is ticked. */
export function PageCheckbox({
  caption,
  isSelected,
  itemKey,
  onToggle,
}: {
  caption: number
  isSelected: boolean
  /** The owner's own name for the page, which `onToggle` is given. */
  itemKey: number
  onToggle: (key: number) => void
}) {
  const { t } = useTranslation()

  return (
    <div className="in-data-[pages-dragging]:hidden" data-page-control>
      <Checkbox
        aria-label={t("pageEdit.selectPage", { pageNumber: caption })}
        checked={isSelected}
        className={cn(
          // The paper is white in either theme, so the box keeps the light
          // theme's colours; the dark theme's would vanish against it.
          "absolute top-1.5 left-1.5 border-neutral-400 bg-white shadow-sm transition-opacity after:-inset-1 data-checked:border-neutral-900 data-checked:bg-neutral-900 data-checked:text-white dark:bg-white dark:data-checked:bg-neutral-900",
          !isSelected && PAPER_CONTROLS_SHOWN,
        )}
        data-page-action="toggle"
        onCheckedChange={() => onToggle(itemKey)}
      />
    </div>
  )
}

/** A page's own bar, shown under the pointer, along the bottom of the square
    its paper stands in: a portrait paper's bottom edge, and where a landscape
    one turned upright would reach, so a turn leaves the bar under the pointer
    for the next press. It acts on its page alone, chosen or not. */
export function PageBar({
  caption,
  deleteDisabled,
  itemKey,
  onAction,
}: {
  caption: number
  /** A document keeps one page, which the bar then offers no way to remove. */
  deleteDisabled: boolean
  /** The owner's own name for the page, which `onAction` is given. */
  itemKey: number
  onAction: (key: number, action: PageAction) => void
}) {
  const { t } = useTranslation()
  const page = { pageNumber: caption }
  const buttons: { action: PageAction; icon: LucideIcon; label: string }[] = [
    { action: "rotate-left", icon: RotateCcw, label: t("pageEdit.rotatePageLeft", page) },
    { action: "rotate-right", icon: RotateCw, label: t("pageEdit.rotatePageRight", page) },
    {
      action: "delete",
      icon: Trash2,
      // A button that cannot act says why, as the bar over the pages does.
      label: deleteDisabled ? t("pageEdit.deleteKeepsOne") : t("pageEdit.deletePage", page),
    },
  ]

  return (
    <div
      className={cn(
        "absolute bottom-1.5 left-1/2 flex -translate-x-1/2 rounded-md border bg-background p-0.5 shadow-sm transition-opacity in-data-[pages-dragging]:hidden",
        PAPER_CONTROLS_SHOWN,
      )}
      data-page-control
    >
      {/* One provider for the three: fewer per cell, and the next hint along
          the bar opens without a fresh delay. */}
      <HintTooltipGroup>
        {buttons.map(({ action, icon: Icon, label }) => (
          <HintTooltip inDelayGroup key={action} label={label}>
            <Button
              aria-label={label}
              // Dimmed, not disabled, while an edit runs, which a press would
              // only be refused behind: a disabled button gives up its focus.
              className={cn(
                "in-data-[pages-busy]:cursor-wait in-data-[pages-busy]:opacity-50",
                action === "delete" && "hover:text-destructive",
              )}
              data-page-action={action}
              disabled={action === "delete" && deleteDisabled}
              onClick={() => onAction(itemKey, action)}
              size="icon-xs"
              variant="ghost"
            >
              <Icon />
            </Button>
          </HintTooltip>
        ))}
      </HintTooltipGroup>
    </div>
  )
}
