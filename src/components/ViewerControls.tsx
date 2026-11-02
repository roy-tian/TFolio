import { RotateCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { StatusBar, StatusBarDivider } from "@/components/StatusBar"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { ZoomControls } from "@/components/ZoomControls"
import { Button } from "@/components/ui/button"
import type { useZoom } from "@/hooks/useZoom"
import type { ViewMode } from "@/lib/viewMode"

type ViewerControlsProps = {
  bookApplies: boolean
  onChangeViewMode: (mode: ViewMode) => void
  onRotate: () => void
  viewMode: ViewMode
  zoom: ReturnType<typeof useZoom>
}

/** How the pages are looked at — layout, zoom, turn — in the status bar,
    leaving the title bar to where the reader is and what they edit. */
export function ViewerControls({
  bookApplies,
  onChangeViewMode,
  onRotate,
  viewMode,
  zoom,
}: ViewerControlsProps) {
  const { t } = useTranslation()
  const rotateLabel = t("toolbar.rotateView")

  return (
    <StatusBar label={t("toolbar.viewControls")}>
      <ViewModeToggle
        bookApplies={bookApplies}
        onChange={onChangeViewMode}
        value={viewMode}
      />
      <StatusBarDivider />
      <ZoomControls zoom={zoom} />
      <StatusBarDivider />
      {/* Turns only the way the pages are looked at (D2); the sidebar's
          previews turn the pages themselves. */}
      <ToolbarTooltip label={rotateLabel}>
        <Button
          aria-label={rotateLabel}
          onClick={onRotate}
          size="icon-sm"
          variant="ghost"
        >
          <RotateCw />
        </Button>
      </ToolbarTooltip>
    </StatusBar>
  )
}
