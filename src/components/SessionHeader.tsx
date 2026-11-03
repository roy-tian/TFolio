import { ChevronDown, FileImage, Save, Scissors, Search, Shrink, Upload } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { AnnotationToolbar, type AnnotationTool } from "@/components/AnnotationToolbar"
import { SidebarToggle } from "@/components/AppSidebar"
import { HistoryControls } from "@/components/HistoryControls"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { WindowControls } from "@/components/WindowControls"
import { WorkspaceSwitch } from "@/components/WorkspaceSwitch"
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
import { useSidebar } from "@/hooks/useSidebar"
import type { HexColor, RectStyle } from "@/lib/annotations"
import { formatShortcut, shortcuts } from "@/lib/shortcuts"
import { splitMenuButtonClassName } from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"

type SessionHeaderProps = {
  active: boolean
  annotations: ReturnType<typeof useAnnotations>
  appMenu: ReactNode
  canSave: boolean
  macOS: boolean
  onCompress: () => void
  onExportImages: () => void
  onSave: () => void
  onSaveAs: () => void
  onSearchClose: () => void
  onSearchOpen: () => void
  onSplit: () => void
  onToolChange: (tool: AnnotationTool) => void
  onUndo: () => void
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
}

/** The toolbar every document tab shares: the editing tools and the file's
    own actions. Where the reader is and how the pages are looked at sit in
    the status bar under the viewer (ViewerControls). */
export function SessionHeader({
  active,
  annotations,
  appMenu,
  canSave,
  macOS,
  onCompress,
  onExportImages,
  onSave,
  onSaveAs,
  onSearchClose,
  onSearchOpen,
  onSplit,
  onToolChange,
  onUndo,
  saveLabel,
  searchOpen,
  tool,
}: SessionHeaderProps) {
  const { t } = useTranslation()

  return (
    <ToolbarFrame
      active={active}
      appMenu={appMenu}
      end={
        <>
          <HistoryControls
            canUndo={annotations.canUndo}
            nextUndo={annotations.nextUndo}
            onUndo={onUndo}
          />
          <AnnotationToolbar
            activeTool={tool.activeTool}
            highlightColor={tool.highlightColor}
            onHighlightColorChange={tool.onHighlightColorChange}
            onPageNumbers={tool.onPageNumbers}
            onRectStyleChange={tool.onRectStyleChange}
            onToolChange={onToolChange}
            onWatermark={tool.onWatermark}
            rectStyle={tool.rectStyle}
            textNoteColor={tool.textNoteColor}
          />
          <ButtonGroup>
            <ToolbarTooltip label={t("search.open")} shortcut={shortcuts.search}>
              <Toggle
                aria-label={t("search.open")}
                className="size-7 min-w-7 p-0"
                data-slot="pdf-search-trigger"
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
        </>
      }
      macOS={macOS}
    />
  )
}

type ToolbarFrameProps = {
  /** Only the bar on show carries the menu and the window controls. */
  active: boolean
  appMenu: ReactNode
  end?: ReactNode
  macOS: boolean
}

/** The title bar right of the sidebar, ending in the app menu and the window
    controls. Without a docked sidebar beside it, it takes over the sidebar's
    first row: the toggle, the workspace switch, the traffic lights. */
export function ToolbarFrame({
  active,
  appMenu,
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
            <SidebarToggle />
            <WorkspaceSwitch />
          </>
        )}
      </div>
      <div className="flex items-center gap-1">
        {end}
        {active ? (
          <>
            {appMenu}
            {macOS ? null : <WindowControls />}
          </>
        ) : null}
      </div>
    </header>
  )
}
