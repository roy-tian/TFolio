import { BookOpen, RectangleVertical, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { toolbarSelectionBarClassName } from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"
import { isViewMode, type ViewMode } from "@/lib/viewMode"

const options: Array<{
  icon: LucideIcon
  labelKey: "statusBar.viewModeSingle" | "statusBar.viewModeBook"
  value: ViewMode
}> = [
  { icon: RectangleVertical, labelKey: "statusBar.viewModeSingle", value: "single" },
  { icon: BookOpen, labelKey: "statusBar.viewModeBook", value: "book" },
]

type ViewModeToggleProps = {
  bookApplies: boolean
  onChange: (mode: ViewMode) => void
  value: ViewMode
}

export function ViewModeToggle({
  bookApplies,
  onChange,
  value,
}: ViewModeToggleProps) {
  const { t } = useTranslation()

  return (
    <ToggleGroup
      aria-label={t("statusBar.viewMode")}
      onValueChange={([next]) => {
        // Base UI empties the array when the active item is pressed again, but
        // a view mode always has to stay selected.
        if (isViewMode(next)) {
          onChange(next)
        }
      }}
      spacing={0}
      value={[value]}
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
