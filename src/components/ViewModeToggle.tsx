import {
  BookOpen,
  LayoutGrid,
  Layers,
  RectangleVertical,
  type LucideIcon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { isViewMode, type ViewMode } from "@/lib/viewMode"

const options: Array<{
  icon: LucideIcon
  labelKey:
    | "toolbar.viewModeSingle"
    | "toolbar.viewModeBook"
    | "toolbar.viewModeThumbnail"
    | "toolbar.viewModeFiles"
  value: ViewMode
}> = [
  { icon: RectangleVertical, labelKey: "toolbar.viewModeSingle", value: "single" },
  { icon: BookOpen, labelKey: "toolbar.viewModeBook", value: "book" },
  { icon: LayoutGrid, labelKey: "toolbar.viewModeThumbnail", value: "thumbnail" },
  { icon: Layers, labelKey: "toolbar.viewModeFiles", value: "files" },
]

type ViewModeToggleProps = {
  /** Whether the document has a spread to show; a single page has none. */
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
          <ToggleGroupItem
            aria-label={label}
            disabled={option.value === "book" && !bookApplies}
            key={option.value}
            title={label}
            value={option.value}
          >
            <Icon />
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}
