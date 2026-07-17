import { Minus, MoveHorizontal, MoveVertical, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { isFitActive, nextFitMode, type ZoomMode } from "@/lib/zoom"

type ZoomControlsProps = {
  canZoomIn: boolean
  canZoomOut: boolean
  disabled: boolean
  onReset: () => void
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
  onReset,
  onToggleFit,
  onZoomIn,
  onZoomOut,
  zoomMode,
  zoomPercent,
}: ZoomControlsProps) {
  const { t } = useTranslation()

  // The button offers the fit the reader does not have, so its icon and label
  // both name what pressing it will do. Whether a fit is on at all is what the
  // pressed state carries.
  const fitActive = isFitActive(zoomMode)
  const nextFit = nextFitMode(zoomMode)
  const FitIcon = nextFit === "fit-width" ? MoveHorizontal : MoveVertical
  const fitLabel =
    nextFit === "fit-width" ? t("toolbar.zoomFitWidth") : t("toolbar.zoomFitHeight")

  const zoomOutLabel = t("toolbar.zoomOut")
  const zoomInLabel = t("toolbar.zoomIn")
  const resetLabel = t("toolbar.zoomReset")

  // Which fit is on belongs here rather than on the fit button, whose name is
  // the fit it would switch *to*. Naming it that and marking it pressed would
  // have a screen reader announce "fit height, pressed" while fit-width is what
  // is actually on.
  const groupLabel =
    zoomMode === "fit-width"
      ? t("toolbar.zoomLevelFitWidth", { percent: zoomPercent })
      : zoomMode === "fit-height"
        ? t("toolbar.zoomLevelFitHeight", { percent: zoomPercent })
        : t("toolbar.zoomLevel", { percent: zoomPercent })

  return (
    // The live percentage rides on the group rather than on the button showing
    // it, whose own label has to stay the action it performs. A screen reader
    // picks the level up on entering the group, instead of being read a new one
    // on every notch of a zoom.
    <ButtonGroup aria-label={groupLabel}>
      <Button
        aria-label={zoomOutLabel}
        disabled={disabled || !canZoomOut}
        onClick={onZoomOut}
        size="icon"
        title={zoomOutLabel}
        variant="outline"
      >
        <Minus />
      </Button>
      <Button
        aria-label={resetLabel}
        // Wide enough for every rung from 25% to 800%, so stepping through them
        // never shifts the buttons either side.
        className="w-14 tabular-nums"
        disabled={disabled}
        onClick={onReset}
        title={resetLabel}
        variant="outline"
      >
        {zoomPercent}%
      </Button>
      <Button
        aria-label={zoomInLabel}
        disabled={disabled || !canZoomIn}
        onClick={onZoomIn}
        size="icon"
        title={zoomInLabel}
        variant="outline"
      >
        <Plus />
      </Button>
      <Button
        aria-label={fitLabel}
        disabled={disabled}
        onClick={onToggleFit}
        size="icon"
        title={fitLabel}
        // Filled while a fit is on, which the group's own name spells out. Not a
        // Toggle, and not aria-pressed: this cycles rather than toggles, and its
        // name is the fit it moves to, not the one it would be reporting.
        //
        // A Toggle would also be the wrong shape here — its outline variant is
        // unfilled where Button's is, which reads as a hole in a joined group.
        // Secondary resolves to the same colour the view-mode group marks its
        // own selection with, so the two groups agree.
        variant={fitActive ? "secondary" : "outline"}
      >
        <FitIcon />
      </Button>
    </ButtonGroup>
  )
}
