import { BookOpen, LayoutGrid, RectangleVertical, type LucideIcon } from "lucide-react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import { useTranslation } from "react-i18next"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ViewMode } from "@/lib/viewMode"

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
  disabled: boolean
  onChange: (mode: ViewMode) => void
  value: ViewMode
}

export function ViewModeToggle({
  disabled,
  onChange,
  value,
}: ViewModeToggleProps) {
  const { t } = useTranslation()

  return (
    <ToggleGroupPrimitive.Root
      aria-label={t("toolbar.viewMode")}
      className="flex items-center gap-0.5"
      onValueChange={(next) => {
        // Radix clears the value when the active item is pressed again, but a
        // view mode always has to stay selected.
        if (next) {
          onChange(next as ViewMode)
        }
      }}
      type="single"
      value={value}
    >
      {options.map((option) => {
        const Icon = option.icon
        const label = t(option.labelKey)

        return (
          <ToggleGroupPrimitive.Item
            aria-label={label}
            className={cn(
              buttonVariants({ size: "icon", variant: "ghost" }),
              "text-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground",
            )}
            disabled={disabled}
            key={option.value}
            title={label}
            value={option.value}
          >
            <Icon />
          </ToggleGroupPrimitive.Item>
        )
      })}
    </ToggleGroupPrimitive.Root>
  )
}
