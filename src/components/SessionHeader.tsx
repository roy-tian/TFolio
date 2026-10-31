import { ChevronDown, FileImage, RotateCw, Save, Scissors, Search, Shrink, Upload } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { SidebarToggle } from "@/components/AppSidebar"
import { HistoryControls } from "@/components/HistoryControls"
import { PageNumberField } from "@/components/PageNumberField"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { WindowControls } from "@/components/WindowControls"
import { WorkspaceSwitch } from "@/components/WorkspaceSwitch"
import { ZoomControls } from "@/components/ZoomControls"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Toggle } from "@/components/ui/toggle"
import type { useAnnotations } from "@/hooks/useAnnotations"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"
import { useSidebar } from "@/hooks/useSidebar"
import type { useZoom } from "@/hooks/useZoom"
import type { HexColor, RectStyle } from "@/lib/annotations"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { formatShortcut, shortcuts } from "@/lib/shortcuts"
import { splitMenuButtonClassName } from "@/lib/toolbarStyles"
import type { ViewMode } from "@/lib/viewMode"
import { cn } from "@/lib/utils"

type SessionHeaderProps = {
  active: boolean
  annotations: ReturnType<typeof useAnnotations>
  /** The app menu; the sidebar carries it while it shows. */
  appMenu: ReactNode
  bookApplies: boolean
  canSave: boolean
  document: PdfDocumentInfo | null
  drawingApplies: boolean
  macOS: boolean
  onChangeViewMode: (mode: ViewMode) => void
  onCompress: () => void
  onExportImages: () => void
  onRotate: () => void
  onSave: () => void
  onSaveAs: () => void
  onSearchClose: () => void
  onSearchOpen: () => void
  onSplit: () => void
  onToolChange: (tool: AnnotationTool) => void
  onUndo: () => void
  page: {
    current: CurrentPage
    onSubmit: (value: string) => void
  }
  saveLabel: string
  searchOpen: boolean
  tool: {
    activeTool: AnnotationTool
    highlightColor: HexColor
    onHighlightColorChange: (color: HexColor) => void
    onPageNumbers: () => void
    onRectStyleChange: (style: RectStyle, transient?: boolean) => void
    onWatermark: () => void
    rectStyle: RectStyle
    textNoteColor: string
  }
  viewMode: ViewMode
  zoom: ReturnType<typeof useZoom>
  zoomApplies: boolean
}

/** The toolbar every document tab shares: reading controls on the left, the
    editing tools and the file's own actions on the right. */
export function SessionHeader({
  active,
  annotations,
  appMenu,
  bookApplies,
  canSave,
  document: pdfDocument,
  drawingApplies,
  macOS,
  onChangeViewMode,
  onCompress,
  onExportImages,
  onRotate,
  onSave,
  onSaveAs,
  onSearchClose,
  onSearchOpen,
  onSplit,
  onToolChange,
  onUndo,
  page,
  saveLabel,
  searchOpen,
  tool,
  viewMode,
  zoom,
  zoomApplies,
}: SessionHeaderProps) {
  const { t } = useTranslation()
  const rotateLabel =
    viewMode === "thumbnail" ? t("toolbar.rotate") : t("toolbar.rotateView")

  return (
    <ToolbarFrame
      appMenu={appMenu}
      end={
        <>
          <HistoryControls
            canUndo={annotations.canUndo}
            disabled={!pdfDocument}
            nextUndo={annotations.nextUndo}
            onUndo={onUndo}
          />
          <AnnotationToolbar
            activeTool={tool.activeTool}
            disabled={!pdfDocument}
            eraserApplies={drawingApplies}
            highlightApplies={drawingApplies}
            highlightColor={tool.highlightColor}
            onHighlightColorChange={tool.onHighlightColorChange}
            onPageNumbers={tool.onPageNumbers}
            onRectStyleChange={tool.onRectStyleChange}
            onToolChange={onToolChange}
            onWatermark={tool.onWatermark}
            rectApplies={drawingApplies}
            rectStyle={tool.rectStyle}
            textNoteApplies={drawingApplies}
            textNoteColor={tool.textNoteColor}
          />
          <ButtonGroup>
            <ToolbarTooltip label={t("search.open")} shortcut={shortcuts.search}>
              <Toggle
                aria-label={t("search.open")}
                className="size-7 min-w-7 p-0"
                data-slot="pdf-search-trigger"
                disabled={!pdfDocument}
                onPressedChange={(pressed) => {
                  if (pressed) {
                    onSearchOpen()
                  } else {
                    onSearchClose()
                  }
                }}
                pressed={searchOpen}
                variant="outline"
              >
                <Search />
              </Toggle>
            </ToolbarTooltip>
            {/* The outline variant's dark: border outranks a plain border-r override. */}
            <ToolbarTooltip label={saveLabel} shortcut={shortcuts.save}>
              <Button
                aria-label={t("annotate.save")}
                className="border-r-transparent peer/save dark:border-r-transparent"
                data-slot="pdf-save-trigger"
                disabled={!canSave}
                onClick={onSave}
                size="icon-sm"
                variant="outline"
              >
                <Save />
              </Button>
            </ToolbarTooltip>
            <DropdownMenu>
              <ToolbarTooltip label={t("toolbar.saveAsMenu")}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={t("toolbar.saveAsMenu")}
                      className={cn(
                        splitMenuButtonClassName,
                        "peer-hover/save:before:opacity-100",
                      )}
                      data-slot="pdf-save-menu-trigger"
                      disabled={!pdfDocument}
                      size="icon-sm"
                      variant="outline"
                    />
                  }
                >
                  <ChevronDown className="size-3" />
                </DropdownMenuTrigger>
              </ToolbarTooltip>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem data-action="save-as" onClick={onSaveAs}>
                  <Upload />
                  {t("menu.saveAs")}
                  <DropdownMenuShortcut>
                    {formatShortcut(shortcuts.saveAs)}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem data-action="export-images" onClick={onExportImages}>
                  <FileImage />
                  {t("imageExport.menuLabel")}
                </DropdownMenuItem>
                <DropdownMenuItem data-action="split" onClick={onSplit}>
                  <Scissors />
                  {t("splitExport.menuLabel")}
                </DropdownMenuItem>
                <DropdownMenuItem data-action="compress" onClick={onCompress}>
                  <Shrink />
                  {t("compressExport.menuLabel")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
          {active && !macOS ? <WindowControls /> : null}
        </>
      }
      macOS={macOS}
    >
      <PageStatus
        currentPage={page.current}
        onSubmit={page.onSubmit}
        pageCount={pdfDocument?.numPages}
      />
      <ViewModeToggle
        bookApplies={bookApplies}
        disabled={!pdfDocument}
        onChange={onChangeViewMode}
        value={viewMode}
      />
      {zoomApplies ? (
        <ZoomControls
          canZoomIn={zoom.canZoomIn}
          canZoomOut={zoom.canZoomOut}
          disabled={!pdfDocument}
          onToggleFit={zoom.toggleFit}
          onZoomIn={zoom.zoomIn}
          onZoomOut={zoom.zoomOut}
          zoomMode={zoom.zoomMode}
          zoomPercent={zoom.zoomPercent}
        />
      ) : null}
      {/* The grid turns the chosen pages in the document; the reading view
          turns only the way they are looked at (D2). */}
      <ToolbarTooltip label={rotateLabel}>
        <Button
          aria-label={rotateLabel}
          disabled={!pdfDocument}
          onClick={onRotate}
          size="icon-sm"
          variant="outline"
        >
          <RotateCw />
        </Button>
      </ToolbarTooltip>
    </ToolbarFrame>
  )
}

type ToolbarFrameProps = {
  appMenu: ReactNode
  children?: ReactNode
  end: ReactNode
  macOS: boolean
}

/** The title bar right of the sidebar. Without a docked sidebar beside it, it
    takes over the sidebar's first row: the menu, the toggle, the traffic lights. */
export function ToolbarFrame({
  appMenu,
  children,
  end,
  macOS,
}: ToolbarFrameProps) {
  const docked = useSidebar().mode === "docked"

  return (
    // pb-px keeps the content box even: an odd row centres a 28px control on a
    // half pixel, which the WebView rounds per element, fringing it.
    <header
      className="fixed top-0 right-0 left-(--sidebar-inset) z-40 flex h-(--toolbar-height) items-center justify-between gap-2 border-b bg-background px-2 pb-px"
      data-slot="toolbar"
      data-tauri-drag-region="deep"
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1",
          !docked && macOS && "pl-[68px]",
        )}
      >
        {docked ? null : (
          <>
            {appMenu}
            <SidebarToggle />
            <WorkspaceSwitch />
            <div className="mx-1 h-4 w-px shrink-0 bg-border" />
          </>
        )}
        {children}
      </div>
      <div className="flex items-center gap-1">{end}</div>
    </header>
  )
}

type PageStatusProps = {
  currentPage: CurrentPage
  onSubmit: (value: string) => void
  /** Absent until a document is open. */
  pageCount: number | undefined
}

/** The one part of the toolbar that follows scrolling, so the only part that
    re-renders as the reader crosses into another page. */
function PageStatus({ currentPage, onSubmit, pageCount }: PageStatusProps) {
  const { t } = useTranslation()
  const current = useCurrentPage(currentPage)
  const status = t("toolbar.pageStatus", { current, total: pageCount ?? 0 })

  return (
    <div
      aria-label={status}
      className="mr-1 flex items-center gap-1.5 font-mono text-sm tabular-nums"
      data-slot="page-status"
      role="group"
    >
      <PageNumberField
        currentPage={current}
        disabled={pageCount === undefined}
        onSubmit={onSubmit}
      />
      <span className="text-muted-foreground">/</span>
      <span>{pageCount ?? 0}</span>
      <span aria-live="polite" className="sr-only">
        {status}
      </span>
    </div>
  )
}
