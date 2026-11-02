import { Brackets, Maximize, ZoomIn, ZoomOut } from "lucide-react"
import type { ComponentType, SVGProps } from "react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  toolbarCenteredStripButtonClassName,
  toolbarSelectionBarClassName,
} from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"
import {
  activeZoomPreset,
  isZoomPreset,
  type ZoomMode,
  type ZoomPreset,
} from "@/lib/zoom"

/** Lucide has no 1:1, so this draws one in its grid and stroke. */
function ActualSizeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M6 8l2-2v12" />
      <path d="M16 8l2-2v12" />
      <path d="M12 10h.01" />
      <path d="M12 14h.01" />
    </svg>
  )
}

const presets: Array<{
  icon: ComponentType<SVGProps<SVGSVGElement>>
  labelKey: "toolbar.zoomActualSize" | "toolbar.zoomFitWidth" | "toolbar.zoomFitPage"
  value: ZoomPreset
}> = [
  { icon: ActualSizeIcon, labelKey: "toolbar.zoomActualSize", value: "actual-size" },
  { icon: Brackets, labelKey: "toolbar.zoomFitWidth", value: "fit-width" },
  { icon: Maximize, labelKey: "toolbar.zoomFitPage", value: "fit-page" },
]

type ZoomControlsProps = {
  canZoomIn: boolean
  canZoomOut: boolean
  disabled: boolean
  onPreset: (preset: ZoomPreset) => void
  onZoomIn: () => void
  onZoomOut: () => void
  zoomMode: ZoomMode
  zoomPercent: number
}

export function ZoomControls({
  canZoomIn,
  canZoomOut,
  disabled,
  onPreset,
  onZoomIn,
  onZoomOut,
  zoomMode,
  zoomPercent,
}: ZoomControlsProps) {
  const { t } = useTranslation()
  const zoomOutLabel = t("toolbar.zoomOut")
  const zoomInLabel = t("toolbar.zoomIn")
  const active = activeZoomPreset(zoomMode, zoomPercent)

  return (
    <>
      {/* No readout: a toolbar figure is read once then ignored, so the
          viewport flashes it; the group's name holds the level for a reader. */}
      <ButtonGroup aria-label={t("toolbar.zoomLevel", { percent: zoomPercent })}>
        <ToolbarTooltip label={zoomOutLabel}>
          <Button
            aria-label={zoomOutLabel}
            disabled={disabled || !canZoomOut}
            onClick={onZoomOut}
            size="icon-sm"
            variant="outline"
          >
            <ZoomOut />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip label={zoomInLabel}>
          <Button
            aria-label={zoomInLabel}
            disabled={disabled || !canZoomIn}
            onClick={onZoomIn}
            size="icon-sm"
            variant="outline"
          >
            <ZoomIn />
          </Button>
        </ToolbarTooltip>
      </ButtonGroup>
      <ToggleGroup
        aria-label={t("toolbar.zoomPresets")}
        disabled={disabled}
        onValueChange={([next]) => {
          // Base UI empties the group when the pressed item is pressed again;
          // that re-applies it, so a fit re-measures against the page in front.
          const preset = isZoomPreset(next) ? next : active

          if (preset) {
            onPreset(preset)
          }
        }}
        spacing={0}
        value={active ? [active] : []}
        variant="outline"
      >
        {presets.map((preset) => {
          const Icon = preset.icon
          const label = t(preset.labelKey)

          return (
            <ToolbarTooltip key={preset.value} label={label}>
              <ToggleGroupItem
                aria-label={label}
                className={cn(
                  toolbarSelectionBarClassName,
                  toolbarCenteredStripButtonClassName,
                  "h-7 min-w-7 group-data-[spacing=0]/toggle-group:px-1.5",
                )}
                value={preset.value}
              >
                <Icon />
              </ToggleGroupItem>
            </ToolbarTooltip>
          )
        })}
      </ToggleGroup>
    </>
  )
}
