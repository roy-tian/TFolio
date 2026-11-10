import { RotateCcw, RotateCw, Trash2, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { PAPER_CONTROLS_SHOWN } from "@/components/PdfThumbnail"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

/** A press or a click on a page's own controls is theirs: no drag, no choice
    of page, and an insertion gap's empty white is not the page beside it. */
export const PAGE_CONTROL = "[data-page-control]"

export type PageAction =
  | "toggle"
  | "rotate-left"
  | "rotate-right"
  | "delete"
  | "insert-before"
  | "insert-after"

/** `byKeyboard`: pressed from the keyboard, whose focus must land somewhere
    if the page goes. `key` is the owner's own name for the page. */
export type PageActionHandler = (key: number, action: PageAction, byKeyboard: boolean) => void

/** A page's checkbox, in its top left corner, and its own bar along the
    bottom; both show under the pointer, the checkbox also while it is ticked. */
export function PageControls({
  caption,
  deleteDisabled = false,
  isSelected,
  itemKey,
  onAction,
}: {
  caption: number
  /** A document keeps one page, which the bar then offers no way to remove. */
  deleteDisabled?: boolean
  isSelected: boolean
  itemKey: number
  onAction: PageActionHandler
}) {
  const { t } = useTranslation()
  const buttons: { action: PageAction; icon: LucideIcon; label: string }[] = [
    { action: "rotate-left", icon: RotateCcw, label: t("pageEdit.rotateCounterclockwise") },
    { action: "rotate-right", icon: RotateCw, label: t("pageEdit.rotateClockwise") },
    { action: "delete", icon: Trash2, label: t("pageEdit.delete", { count: 1 }) },
  ]

  return (
    <div
      // Focus inside the controls shows them, not focus on the paper: WebKitGTK
      // can keep a clicked paper `:focus-visible`, and its bar would stay up.
      className="has-focus-visible:[--paper-controls:1] in-data-[pages-dragging]:hidden"
      data-page-control
    >
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
        onCheckedChange={() => onAction(itemKey, "toggle", false)}
      />
      <div
        className={cn(
          "absolute bottom-1.5 left-1/2 flex -translate-x-1/2 rounded-md border bg-background p-0.5 shadow-sm transition-opacity",
          PAPER_CONTROLS_SHOWN,
        )}
      >
        {buttons.map(({ action, icon: Icon, label }) => (
          <HintTooltip key={action} label={label}>
            <Button
              aria-label={label}
              // Dimmed, not hidden, while an edit runs, which a press would
              // only be refused behind: a hidden button gives up its focus.
              className={cn(
                "in-data-[pages-busy]:cursor-wait in-data-[pages-busy]:opacity-50",
                action === "delete" && "hover:text-destructive",
              )}
              data-page-action={action}
              disabled={action === "delete" && deleteDisabled}
              // A click the keyboard made counts no presses.
              onClick={(event) => onAction(itemKey, action, event.detail === 0)}
              size="icon-xs"
              variant="ghost"
            >
              <Icon />
            </Button>
          </HintTooltip>
        ))}
      </div>
    </div>
  )
}
