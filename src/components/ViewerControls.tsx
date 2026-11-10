import { RotateCw } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PageStatus } from "@/components/PageStatus"
import { StatusBar, StatusBarDivider } from "@/components/StatusBar"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { ZoomControls } from "@/components/ZoomControls"
import { Button } from "@/components/ui/button"
import type { CurrentPage } from "@/hooks/useCurrentPage"
import type { useZoom } from "@/hooks/useZoom"
import type { ViewMode } from "@/lib/viewMode"

type ViewerControlsProps = {
  bookApplies: boolean
  /** The page grid lies over the reading view, which has no scale there. */
  gridShown: boolean
  onChangeViewMode: (mode: ViewMode) => void
  onShowGrid: () => void
  onRotate: () => void
  page: {
    count: number
    current: CurrentPage
    onSubmit: (value: string) => void
  }
  viewMode: ViewMode
  zoom: ReturnType<typeof useZoom>
}

/** The status bar under the viewer: where the reader is on the left, how the
    pages are looked at — layout, zoom, turn — on the right, leaving the title
    bar to what they edit. */
export function ViewerControls({
  bookApplies,
  gridShown,
  onChangeViewMode,
  onRotate,
  onShowGrid,
  page,
  viewMode,
  zoom,
}: ViewerControlsProps) {
  const { t } = useTranslation()
  const rotateLabel = t("statusBar.rotateView")

  return (
    <StatusBar
      label={t("statusBar.viewControls")}
      start={
        <PageStatus
          currentPage={page.current}
          onSubmit={page.onSubmit}
          pageCount={page.count}
        />
      }
    >
      <ViewModeToggle
        bookApplies={bookApplies}
        gridShown={gridShown}
        onChange={onChangeViewMode}
        onShowGrid={onShowGrid}
        value={viewMode}
      />
      <StatusBarDivider />
      {/* Absent rather than disabled: disabled is what an unopened document
          means. */}
      {gridShown ? null : (
        <>
          <ZoomControls zoom={zoom} />
          <StatusBarDivider />
        </>
      )}
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
