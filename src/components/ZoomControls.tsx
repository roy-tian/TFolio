import { Brackets, Maximize, ZoomIn, ZoomOut } from "lucide-react"
import { useTranslation } from "react-i18next"

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

  // The button offers the fit the reader does not have, so its icon and label
  // both name what pressing it will do. Whether a fit is on at all is what the
  // pressed state carries.
  //
  // Both fits are drawn as the frame the page is being fitted into — all four
  // corners for the page, the two side edges alone for the width. An arrow
  // would name the direction more plainly, but it is the one icon in the
  // toolbar with no border, and next to the other it reads as a different kind
  // of control rather than the same one in its other position.
  const fitActive = isFitActive(zoomMode)
  const nextFit = nextFitMode(zoomMode)
  const FitIcon = nextFit === "fit-width" ? Brackets : Maximize
  const fitLabel =
    nextFit === "fit-width" ? t("toolbar.zoomFitWidth") : t("toolbar.zoomFitPage")

  const zoomOutLabel = t("toolbar.zoomOut")
  const zoomInLabel = t("toolbar.zoomIn")

  // Which fit is on belongs here rather than on the fit button, whose name is
  // the fit it would switch *to*. Naming it that and marking it pressed would
  // have a screen reader announce "fit page, pressed" while fit-width is what
  // is actually on.
  const groupLabel =
    zoomMode === "fit-width"
      ? t("toolbar.zoomLevelFitWidth", { percent: zoomPercent })
      : zoomMode === "fit-page"
        ? t("toolbar.zoomLevelFitPage", { percent: zoomPercent })
        : t("toolbar.zoomLevel", { percent: zoomPercent })

  return (
    // Three actions, no readout: a figure sitting in the toolbar is read once
    // and then ignored, so the viewport flashes it on each zoom instead. The
    // group's own name is what keeps it available to a screen reader, and it
    // belongs on the group rather than on any one button, whose label has to
    // stay the action it performs — so entering the group reads the level once
    // instead of re-reading it on every notch.
    <ButtonGroup aria-label={groupLabel}>
      <Button
        aria-label={zoomOutLabel}
        disabled={disabled || !canZoomOut}
        onClick={onZoomOut}
        size="icon"
        title={zoomOutLabel}
        variant="outline"
      >
        <ZoomOut />
      </Button>
      <Button
        aria-label={zoomInLabel}
        disabled={disabled || !canZoomIn}
        onClick={onZoomIn}
        size="icon"
        title={zoomInLabel}
        variant="outline"
      >
        <ZoomIn />
      </Button>
      <Button
        aria-label={fitLabel}
        className={fitActive ? "border-border dark:border-input" : undefined}
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
        // own selection with, so the two groups agree. Keep the outline colour
        // explicit because the secondary variant otherwise makes it transparent.
        variant={fitActive ? "secondary" : "outline"}
      >
        <FitIcon />
      </Button>
    </ButtonGroup>
  )
}
