import { BookOpen, LayoutGrid, RectangleVertical, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { toolbarSelectionBarClassName } from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"
import { isViewMode, type ViewMode } from "@/lib/viewMode"

/** The two reading views and the page grid, which lies over whichever of the
    two was shown and gives way to it again. */
type ShownView = ViewMode | "grid"

const options: Array<{
  icon: LucideIcon
  labelKey: "statusBar.viewModeSingle" | "statusBar.viewModeBook" | "statusBar.viewModeGrid"
  value: ShownView
}> = [
  { icon: RectangleVertical, labelKey: "statusBar.viewModeSingle", value: "single" },
  { icon: BookOpen, labelKey: "statusBar.viewModeBook", value: "book" },
  { icon: LayoutGrid, labelKey: "statusBar.viewModeGrid", value: "grid" },
]

type ViewModeToggleProps = {
  bookApplies: boolean
  gridShown: boolean
  onChange: (mode: ViewMode) => void
  onShowGrid: () => void
  value: ViewMode
}

export function ViewModeToggle({
  bookApplies,
  gridShown,
  onChange,
  onShowGrid,
  value,
}: ViewModeToggleProps) {
  const { t } = useTranslation()

  return (
    <ToggleGroup
      aria-label={t("statusBar.viewMode")}
      onValueChange={([next]) => {
        // Base UI empties the array when the active item is pressed again, but
        // a view always has to stay selected.
        if (next === "grid") {
          onShowGrid()
        } else if (isViewMode(next)) {
          onChange(next)
        }
      }}
      spacing={0}
      value={[gridShown ? "grid" : value]}
    >
      {options.map((option) => {
        const Icon = option.icon
        const label = t(option.labelKey)

        return (
          <ToolbarTooltip key={option.value} label={label}>
            <ToggleGroupItem
              aria-label={label}
              className={cn(
                toolbarSelectionBarClassName,
                "h-7 min-w-7 group-data-[spacing=0]/toggle-group:px-1.5",
              )}
              disabled={option.value === "book" && !bookApplies}
              value={option.value}
            >
              <Icon />
            </ToggleGroupItem>
          </ToolbarTooltip>
        )
      })}
    </ToggleGroup>
  )
}
