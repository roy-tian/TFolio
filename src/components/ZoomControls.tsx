import { Brackets, Maximize } from "lucide-react"
import type { ComponentType, SVGProps } from "react"
import { useTranslation } from "react-i18next"

import { SliderStepper } from "@/components/SliderStepper"
import { StatusBarDivider } from "@/components/StatusBar"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { useZoom } from "@/hooks/useZoom"
import { shortcuts, type Shortcut } from "@/lib/shortcuts"
import { toolbarSelectionBarClassName } from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"
import {
  activeZoomPreset,
  isZoomPreset,
  sliderValueToZoom,
  ZOOM_SLIDER_MAX,
  ZOOM_SLIDER_MIN,
  zoomToPercent,
  zoomToSliderValue,
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
  shortcut?: Shortcut
  value: ZoomPreset
}> = [
  {
    icon: ActualSizeIcon,
    labelKey: "toolbar.zoomActualSize",
    shortcut: shortcuts.actualSize,
    value: "actual-size",
  },
  { icon: Brackets, labelKey: "toolbar.zoomFitWidth", value: "fit-width" },
  { icon: Maximize, labelKey: "toolbar.zoomFitPage", value: "fit-page" },
]

type ZoomControlsProps = {
  zoom: ReturnType<typeof useZoom>
}

/** The zoom half of the status bar: minus, slider, plus and the level, then
    the sizings named by the toolbar. */
export function ZoomControls({ zoom }: ZoomControlsProps) {
  const { t } = useTranslation()
  const active = activeZoomPreset(zoom.zoomMode, zoom.zoomPercent)
  const percentText = (step: number) =>
    t("toolbar.zoomPercent", { percent: zoomToPercent(sliderValueToZoom(step)) })

  return (
    <>
      <SliderStepper
        canDecrease={zoom.canZoomOut}
        canIncrease={zoom.canZoomIn}
        decrease={{ label: t("toolbar.zoomOut"), shortcut: shortcuts.zoomOut }}
        groupLabel={t("toolbar.zoomLevel", { percent: zoom.zoomPercent })}
        increase={{ label: t("toolbar.zoomIn"), shortcut: shortcuts.zoomIn }}
        max={ZOOM_SLIDER_MAX}
        min={ZOOM_SLIDER_MIN}
        // The pages are only laid out again once the drag lets go.
        onCommit={zoom.commitPreview}
        onDecrease={zoom.zoomOut}
        onIncrease={zoom.zoomIn}
        onPreview={(step) => zoom.previewScale(sliderValueToZoom(step))}
        readout={percentText}
        sliderLabel={t("toolbar.zoom")}
        slot="zoom-controls"
        value={zoomToSliderValue(zoom.scale)}
        valueText={percentText}
      />
      <StatusBarDivider />
      <ToggleGroup
        aria-label={t("toolbar.zoomPresets")}
        onValueChange={([next]) => {
          // Base UI empties the group when the pressed item is pressed again;
          // that re-applies it, so a fit re-measures against the page in front.
          const preset = isZoomPreset(next) ? next : active

          if (preset) {
            zoom.applyPreset(preset)
          }
        }}
        spacing={0}
        value={active ? [active] : []}
      >
        {presets.map((preset) => {
          const Icon = preset.icon
          const label = t(preset.labelKey)

          return (
            <ToolbarTooltip key={preset.value} label={label} shortcut={preset.shortcut}>
              <ToggleGroupItem
                aria-label={label}
                className={cn(
                  toolbarSelectionBarClassName,
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
