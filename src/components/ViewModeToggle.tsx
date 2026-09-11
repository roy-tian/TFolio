import {
  BookOpen,
  LayoutGrid,
  RectangleVertical,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { toolbarSelectionBarClassName } from "@/lib/toolbarStyles"
import { isViewMode, type ViewMode } from "@/lib/viewMode"

const options: Array<{
  icon: LucideIcon
  labelKey:
    | "toolbar.viewModeSingle"
    | "toolbar.viewModeBook"
    | "toolbar.viewModeThumbnail"
  value: ViewMode
}> = [
  { icon: RectangleVertical, labelKey: "toolbar.viewModeSingle", value: "single" },
  { icon: BookOpen, labelKey: "toolbar.viewModeBook", value: "book" },
  { icon: LayoutGrid, labelKey: "toolbar.viewModeThumbnail", value: "thumbnail" },
]

type ViewModeToggleProps = {
  bookApplies: boolean
  disabled: boolean
  onChange: (mode: ViewMode) => void
  value: ViewMode
}

export function ViewModeToggle({
  bookApplies,
  disabled,
  onChange,
  value,
}: ViewModeToggleProps) {
  const { t } = useTranslation()

  return (
    <ToggleGroup
      aria-label={t("toolbar.viewMode")}
      disabled={disabled}
      onValueChange={([next]) => {
        // Base UI empties the array when the active item is pressed again, but
        // a view mode always has to stay selected.
        if (isViewMode(next)) {
          onChange(next)
        }
      }}
      spacing={0}
      value={[value]}
      variant="outline"
    >
      {options.map((option) => {
        const Icon = option.icon
        const label = t(option.labelKey)

        return (
          <ToolbarTooltip key={option.value} label={label}>
            <ToggleGroupItem
              aria-label={label}
              className={toolbarSelectionBarClassName}
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
