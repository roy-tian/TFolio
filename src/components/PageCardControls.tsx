import { useTranslation } from "react-i18next"

import { PAPER_CONTROLS_SHOWN } from "@/components/PdfThumbnail"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

/** A press or a click on a page's own controls is theirs: no drag, no choice
    of page, and an insertion gap's empty white is not the page beside it. */
export const PAGE_CONTROL = "[data-page-control]"

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
