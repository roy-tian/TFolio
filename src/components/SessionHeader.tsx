import { Bookmark, Printer, RotateCw, Save, Search } from "lucide-react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import { HistoryControls } from "@/components/HistoryControls"
import { PageNumberField } from "@/components/PageNumberField"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { ViewModeToggle } from "@/components/ViewModeToggle"
import { WindowControls } from "@/components/WindowControls"
import { ZoomControls } from "@/components/ZoomControls"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Toggle } from "@/components/ui/toggle"
import type { useAnnotations } from "@/hooks/useAnnotations"
import type { usePrint } from "@/hooks/usePrint"
import type { useZoom } from "@/hooks/useZoom"
import type { HexColor, RectStyle } from "@/lib/annotations"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { shortcuts } from "@/lib/shortcuts"
import type { ViewMode } from "@/lib/viewMode"
import { cn } from "@/lib/utils"

type SessionHeaderProps = {
  active: boolean
  annotations: ReturnType<typeof useAnnotations>
  bookmarksApply: boolean
  bookmarksLabel: string
  bookmarksOpen: boolean
  bookApplies: boolean
  canSave: boolean
  document: PdfDocumentInfo | null
  drawingApplies: boolean
  macOS: boolean
  menu: AppMenuActions
  onBookmarksOpenChange: (open: boolean) => void
  onChangeViewMode: (mode: ViewMode) => void
  onRotate: () => void
  onRedo: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onCompress: () => void
  onSearchClose: () => void
  onSearchOpen: () => void
  onToolChange: (tool: AnnotationTool) => void
  onUndo: () => void
  page: {
    current: number
    input: string
    inputFocused: boolean
    onFocusedChange: (focused: boolean) => void
    onInput: (value: string) => void
    onSubmit: () => void
  }
  print: ReturnType<typeof usePrint>
  saveHint: string | undefined
  saveLabel: string
  searchOpen: boolean
  tool: {
    activeTool: AnnotationTool
    highlightColor: HexColor
    onHighlightColorChange: (color: HexColor) => void
    onPageNumbers: () => void
    onRectStyleChange: (style: RectStyle) => void
    onWatermark: () => void
    rectStyle: RectStyle
    textNoteColor: string
  }
  viewMode: ViewMode
  zoom: ReturnType<typeof useZoom>
  zoomApplies: boolean
}

/** The fixed header every document tab shares: file actions, view controls,
    the page odometer, and the annotation tools. */
export function SessionHeader({
  active,
  annotations,
  bookmarksApply,
  bookmarksLabel,
  bookmarksOpen,
  bookApplies,
  canSave,
  document: pdfDocument,
  drawingApplies,
  macOS,
  menu,
  onBookmarksOpenChange,
  onChangeViewMode,
  onRotate,
  onRedo,
  onSave,
  onSaveAs,
  onExport,
  onCompress,
  onSearchClose,
  onSearchOpen,
  onToolChange,
  onUndo,
  page,
  print,
  saveHint,
  saveLabel,
  searchOpen,
  tool,
  viewMode,
  zoom,
  zoomApplies,
}: SessionHeaderProps) {
  const { t } = useTranslation()

  return (
    // pb-px keeps the content box even: a 47px row centres a 32px control
    // on a half pixel, which the WebView rounds per element, fringing it.
    <header
      className="fixed inset-x-0 top-0 z-50 grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b bg-background/95 px-2 pb-px shadow-xs backdrop-blur"
      data-tauri-drag-region="deep"
    >
      <div
        className={cn(
          "flex items-center gap-1 justify-self-start",
          macOS && "pl-[72px]",
        )}
      >
        {active ? (
          <AppMenu
            {...menu}
            canSave={canSave}
            onSave={onSave}
            onSaveAs={onSaveAs}
            onExport={pdfDocument ? onExport : undefined}
            onCompress={pdfDocument ? onCompress : undefined}
            saveHint={saveHint}
          />
        ) : null}
        <ToolbarTooltip label={bookmarksLabel}>
          <Toggle
            aria-label={bookmarksLabel}
            className="size-8"
            disabled={!pdfDocument || !bookmarksApply}
            onPressedChange={onBookmarksOpenChange}
            pressed={bookmarksOpen}
            variant="outline"
          >
            <Bookmark className={bookmarksOpen ? "fill-current" : undefined} />
          </Toggle>
        </ToolbarTooltip>
        <ButtonGroup>
          {/* The chord is named only when it works: a disabled save
              spends the tooltip on why it cannot. */}
          <ToolbarTooltip
            label={saveLabel}
            shortcut={canSave ? shortcuts.save : undefined}
          >
            <Button
              aria-label={t("annotate.save")}
              // A disabled control takes no pointer, and the hint saying why
              // saving is unavailable has to have a hover to open on.
              className="disabled:pointer-events-auto"
              data-slot="pdf-save-trigger"
              disabled={!canSave}
              onClick={onSave}
              size="icon"
              variant="outline"
            >
              <Save />
            </Button>
          </ToolbarTooltip>
          <ToolbarTooltip label={t("print.open")} shortcut={shortcuts.print}>
            <Button
              aria-label={t("print.open")}
              data-slot="pdf-print-trigger"
              disabled={!pdfDocument || print.preparing}
              onClick={() => void print.start()}
              size="icon"
              variant="outline"
            >
              <Printer />
            </Button>
          </ToolbarTooltip>
          <ToolbarTooltip label={t("search.open")} shortcut={shortcuts.search}>
            <Toggle
              aria-label={t("search.open")}
              className="size-8"
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
        </ButtonGroup>
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
        <ToolbarTooltip label={t("toolbar.rotate")}>
          <Button
            aria-label={t("toolbar.rotate")}
            disabled={!pdfDocument}
            onClick={onRotate}
            size="icon"
            variant="outline"
          >
            <RotateCw />
          </Button>
        </ToolbarTooltip>
      </div>

      <div
        aria-label={t("toolbar.pageStatus", {
          current: page.current,
          total: pdfDocument?.numPages ?? 0,
        })}
        className="flex min-w-24 items-center justify-center gap-2 font-mono text-sm tabular-nums"
        data-slot="page-status"
        role="group"
      >
        <PageNumberField
          currentPage={page.current}
          disabled={!pdfDocument}
          focused={page.inputFocused}
          onFocusedChange={page.onFocusedChange}
          onInput={page.onInput}
          onSubmit={page.onSubmit}
          value={page.input}
        />
        <span className="text-muted-foreground">/</span>
        <span>{pdfDocument?.numPages ?? 0}</span>
        <span aria-live="polite" className="sr-only">
          {t("toolbar.pageStatus", {
            current: page.current,
            total: pdfDocument?.numPages ?? 0,
          })}
        </span>
      </div>

      <div className="flex items-center gap-1 justify-self-end">
        <HistoryControls
          canRedo={annotations.canRedo}
          canUndo={annotations.canUndo}
          disabled={!pdfDocument}
          nextRedo={annotations.nextRedo}
          nextUndo={annotations.nextUndo}
          onRedo={onRedo}
          onUndo={onUndo}
        />
        <AnnotationToolbar
          activeTool={tool.activeTool}
          disabled={!pdfDocument}
          eraserApplies={drawingApplies}
          highlightApplies={drawingApplies}
          highlightColor={tool.highlightColor}
          onHighlightColorChange={tool.onHighlightColorChange}
          onMergeWizard={menu.onMergeWizard}
          onPageNumbers={tool.onPageNumbers}
          onRectStyleChange={tool.onRectStyleChange}
          onToolChange={onToolChange}
          onWatermark={tool.onWatermark}
          rectApplies={drawingApplies}
          rectStyle={tool.rectStyle}
          textNoteApplies={drawingApplies}
          textNoteColor={tool.textNoteColor}
        />
        {active && !macOS ? <WindowControls /> : null}
      </div>
    </header>
  )
}
