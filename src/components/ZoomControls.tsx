import { Brackets, Maximize, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { SliderStepper } from "@/components/SliderStepper"
import { StatusBarDivider } from "@/components/StatusBar"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { useZoom } from "@/hooks/useZoom"
import { shortcuts } from "@/lib/shortcuts"
import { toolbarSelectionBarClassName } from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"
import {
  isZoomFit,
  sliderValueToZoom,
  ZOOM_SLIDER_MAX,
  ZOOM_SLIDER_MIN,
  zoomToPercent,
  zoomToSliderValue,
  type ZoomFit,
} from "@/lib/zoom"

const fits: Array<{
  icon: LucideIcon
  labelKey: "statusBar.zoomFitWidth" | "statusBar.zoomFitPage"
  value: ZoomFit
}> = [
  { icon: Brackets, labelKey: "statusBar.zoomFitWidth", value: "fit-width" },
  { icon: Maximize, labelKey: "statusBar.zoomFitPage", value: "fit-page" },
]

type ZoomControlsProps = {
  zoom: ReturnType<typeof useZoom>
}

/** The zoom half of the status bar: minus, slider, plus and the level, which
    goes back to 100% when pressed, then the fits. */
export function ZoomControls({ zoom }: ZoomControlsProps) {
  const { t } = useTranslation()
  const active = isZoomFit(zoom.zoomMode) ? zoom.zoomMode : null
  const percentAt = (step: number) => zoomToPercent(sliderValueToZoom(step))
  const percentText = (step: number) => t("statusBar.zoomPercent", { percent: percentAt(step) })
  // Read off the level shown: an opening fit a hair off 100% shows 100% too.
  const atActualSize = (step: number) => percentAt(step) === 100

  return (
    <>
      <SliderStepper
        canDecrease={zoom.canZoomOut}
        canIncrease={zoom.canZoomIn}
        decrease={{ label: t("statusBar.zoomOut"), shortcut: shortcuts.zoomOut }}
        groupLabel={t("statusBar.zoomLevel", { percent: zoom.zoomPercent })}
        increase={{ label: t("statusBar.zoomIn"), shortcut: shortcuts.zoomIn }}
        max={ZOOM_SLIDER_MAX}
        min={ZOOM_SLIDER_MIN}
        // The pages are only laid out again once the drag lets go.
        onCommit={zoom.commitPreview}
        onDecrease={zoom.zoomOut}
        onIncrease={zoom.zoomIn}
        onPreview={(step) => zoom.previewScale(sliderValueToZoom(step))}
        readout={{
          hint: t("statusBar.zoomReset"),
          idle: atActualSize,
          label: (step) =>
            t(atActualSize(step) ? "statusBar.zoomCurrent" : "statusBar.zoomReadout", {
              level: percentText(step),
            }),
          onPress: () => zoom.applyPreset("actual-size"),
          shortcut: shortcuts.actualSize,
          text: percentText,
        }}
        sliderLabel={t("statusBar.zoom")}
        slot="zoom-controls"
        value={zoomToSliderValue(zoom.scale)}
        valueText={percentText}
      />
      <StatusBarDivider />
      <ToggleGroup
        aria-label={t("statusBar.zoomPresets")}
        onValueChange={([next]) => {
          // Base UI empties the group when the pressed item is pressed again;
          // that re-applies it, so a fit re-measures against the page in front.
          const fit = isZoomFit(next) ? next : active

          if (fit) {
            zoom.applyPreset(fit)
          }
        }}
        spacing={0}
        value={active ? [active] : []}
      >
        {fits.map((fit) => {
          const Icon = fit.icon
          const label = t(fit.labelKey)

          return (
            <ToolbarTooltip key={fit.value} label={label}>
              <ToggleGroupItem
                aria-label={label}
                className={cn(
                  toolbarSelectionBarClassName,
                  "h-7 min-w-7 group-data-[spacing=0]/toggle-group:px-1.5",
                )}
                value={fit.value}
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
