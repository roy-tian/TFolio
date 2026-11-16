import { useTranslation } from "react-i18next"

import { PageStatus } from "@/components/PageStatus"
import { StatusBar, StatusBarDivider } from "@/components/StatusBar"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { ZoomControls } from "@/components/ZoomControls"
import type { CurrentPage } from "@/hooks/useCurrentPage"
import type { useZoom } from "@/hooks/useZoom"
import type { ViewMode } from "@/lib/viewMode"

type ViewerControlsProps = {
  bookApplies: boolean
  onChangeViewMode: (mode: ViewMode) => void
  page: {
    count: number
    current: CurrentPage
    onSubmit: (value: string) => void
  }
  viewMode: ViewMode
  zoom: ReturnType<typeof useZoom>
}

/** The status bar under the viewer: where the reader is on the left, how the
    pages are looked at — layout and zoom — on the right, leaving the title bar
    to what they edit. */
export function ViewerControls({
  bookApplies,
  onChangeViewMode,
  page,
  viewMode,
  zoom,
}: ViewerControlsProps) {
  const { t } = useTranslation()

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
      <ViewModeToggle bookApplies={bookApplies} onChange={onChangeViewMode} value={viewMode} />
      <StatusBarDivider />
      <ZoomControls zoom={zoom} />
    </StatusBar>
  )
}
