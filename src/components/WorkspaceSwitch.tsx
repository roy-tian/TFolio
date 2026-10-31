import { BookOpenText, Layers } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useWorkspaceMode, type WorkspaceMode } from "@/hooks/useWorkspaceMode"
import {
  toolbarCenteredStripButtonClassName,
  toolbarSelectionBarClassName,
} from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"

const modes = [
  { icon: BookOpenText, labelKey: "organize.modeView", value: "view" },
  { icon: Layers, labelKey: "organize.modeOrganize", value: "organize" },
] as const

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === "view" || value === "organize"
}

export function WorkspaceSwitch() {
  const { t } = useTranslation()
  const workspace = useWorkspaceMode()

  if (!workspace) {
    return null
  }

  return (
    <ToggleGroup
      aria-label={t("organize.modes")}
      data-slot="workspace-switch"
      onValueChange={([next]) => {
        // Pressing the shown mode again would empty the group; one stays on.
        if (isWorkspaceMode(next)) {
          workspace.setMode(next)
        }
      }}
      spacing={0}
      value={[workspace.mode]}
      variant="outline"
    >
      {modes.map((mode) => {
        const Icon = mode.icon
        const label = t(mode.labelKey)

        return (
          <ToolbarTooltip key={mode.value} label={label}>
            <ToggleGroupItem
              aria-label={label}
              className={cn(
                toolbarSelectionBarClassName,
                toolbarCenteredStripButtonClassName,
                "h-7 min-w-7 group-data-[spacing=0]/toggle-group:px-1.5",
              )}
              value={mode.value}
            >
              <Icon />
            </ToggleGroupItem>
          </ToolbarTooltip>
        )
      })}
    </ToggleGroup>
  )
}
