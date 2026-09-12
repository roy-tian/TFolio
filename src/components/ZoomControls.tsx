import { Brackets, Maximize, ZoomIn, ZoomOut } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { isFitActive, nextFitMode, type ZoomMode } from "@/lib/zoom"

type ZoomControlsProps = {
  canZoomIn: boolean
  canZoomOut: boolean
  disabled: boolean
  onToggleFit: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  zoomMode: ZoomMode
  zoomPercent: number
}

export function ZoomControls({
  canZoomIn,
  canZoomOut,
  disabled,
  onToggleFit,
  onZoomIn,
  onZoomOut,
  zoomMode,
  zoomPercent,
}: ZoomControlsProps) {
  const { t } = useTranslation()

  // Offers the fit the reader does not have — icon and label name what pressing
  // does — and both fits draw a frame, an arrow reading as a different control.
  const fitActive = isFitActive(zoomMode)
  const nextFit = nextFitMode(zoomMode)
  const FitIcon = nextFit === "fit-width" ? Brackets : Maximize
  const fitLabel =
    nextFit === "fit-width" ? t("toolbar.zoomFitWidth") : t("toolbar.zoomFitPage")

  const zoomOutLabel = t("toolbar.zoomOut")
  const zoomInLabel = t("toolbar.zoomIn")

  // Which fit is on belongs here: the button's name is the fit it would switch
  // *to*, so "pressed" there would announce the fit that is not on.
  const groupLabel =
    zoomMode === "fit-width"
      ? t("toolbar.zoomLevelFitWidth", { percent: zoomPercent })
      : zoomMode === "fit-page"
        ? t("toolbar.zoomLevelFitPage", { percent: zoomPercent })
        : t("toolbar.zoomLevel", { percent: zoomPercent })

  return (
    // Three actions, no readout: a toolbar figure is read once then ignored, so
    // the viewport flashes it; the group's name holds the level for a reader.
    <ButtonGroup aria-label={groupLabel}>
      <ToolbarTooltip label={zoomOutLabel}>
        <Button
          aria-label={zoomOutLabel}
          disabled={disabled || !canZoomOut}
          onClick={onZoomOut}
          size="icon"
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
          size="icon"
          variant="outline"
        >
          <ZoomIn />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={fitLabel}>
        <Button
          aria-label={fitLabel}
          className={fitActive ? "border-border dark:border-input" : undefined}
          disabled={disabled}
          onClick={onToggleFit}
          size="icon"
          // Not a Toggle and no aria-pressed: it cycles, naming the fit it moves
          // to. The border stays explicit — secondary would make it transparent.
          variant={fitActive ? "secondary" : "outline"}
        >
          <FitIcon />
        </Button>
      </ToolbarTooltip>
    </ButtonGroup>
  )
}
