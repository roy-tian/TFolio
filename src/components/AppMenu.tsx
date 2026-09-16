import { useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  AppWindow,
  FileArchive,
  FilePlus2,
  FolderOpen,
  History,
  Info,
  LogOut,
  Menu,
  Save,
  SaveAll,
  Settings,
  SquareX,
  Upload,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import fileTinyIcon from "@/assets/brand/file-tiny.svg"
import { HintTooltip } from "@/components/HintTooltip"
import {
  SettingsDialog,
  type SettingsSection,
} from "@/components/SettingsDialog"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { RecentFile } from "@/lib/recentFiles"
import { formatShortcut, shortcuts } from "@/lib/shortcuts"

/** The submenu's share of the recent list: a menu longer than the window
    scrolls offscreen, and the home tab already owns the whole list. */
const RECENT_MENU_LIMIT = 10

/** The entries that act on the workspace rather than on one document, so the
    home tab's menu and every document's carry the same ones. */
export type AppMenuActions = {
  canCloseAll: boolean
  canSaveAll: boolean
  onCloseAll: () => void
  /** Not a menu entry: it is a toolbar button (`MergeWizardButton`), and this
      bag is how it reaches every header. */
  onMergeWizard: () => void
  onNew: () => void
  onNewWindow: () => void
  onOpen: () => void
  onOpenRecent: (path: string) => void
  /** Read the recent list again as the menu opens: it is the backend's, and a
      document tab's menu would otherwise show whatever the home tab last saw. */
  onRefreshRecent: () => void
  /** One keystroke for a session spread over several tabs. Workspace-wide, so
      it is the menu's alone — no document's toolbar speaks for the tabs. */
  onSaveAll: () => void
  recentFiles: RecentFile[]
}

type AppMenuProps = AppMenuActions & {
  canSave?: boolean
  onSave?: () => void
  onSaveAs?: () => void
  onExport?: () => void
  saveHint?: string
}

export function AppMenu({
  canCloseAll,
  canSave = false,
  canSaveAll,
  onCloseAll,
  onNew,
  onNewWindow,
  onOpen,
  onOpenRecent,
  onRefreshRecent,
  onSave,
  onSaveAll,
  onSaveAs,
  onExport,
  recentFiles,
  saveHint,
}: AppMenuProps) {
  const { t } = useTranslation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection>("appearance")

  const showSettings = (target: SettingsSection) => {
    setSection(target)
    setSettingsOpen(true)
  }

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            onRefreshRecent()
          }
        }}
      >
        <ToolbarTooltip label={t("menu.title")}>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("menu.title")}
                className="text-brand hover:text-brand-strong aria-expanded:text-brand-strong"
                data-slot="app-menu"
                size="icon"
                variant="outline"
              />
            }
          >
            <Menu />
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem data-action="new" onClick={onNew}>
              <FilePlus2 />
              {t("menu.new")}
              <DropdownMenuShortcut>
                {formatShortcut(shortcuts.new)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem data-action="new-window" onClick={onNewWindow}>
              <AppWindow />
              {t("menu.newWindow")}
              <DropdownMenuShortcut>
                {formatShortcut(shortcuts.newWindow)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem data-action="open" onClick={onOpen}>
              <FolderOpen />
              {t("menu.openFile")}
              <DropdownMenuShortcut>
                {formatShortcut(shortcuts.open)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-action="open-recent">
                <History />
                {t("menu.openRecent")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                {recentFiles.length === 0 ? (
                  <DropdownMenuItem disabled>
                    {t("menu.recentEmpty")}
                  </DropdownMenuItem>
                ) : (
                  recentFiles.slice(0, RECENT_MENU_LIMIT).map((file) => (
                    <HintTooltip key={file.path} label={file.path} side="right">
                      <DropdownMenuItem
                        data-action="recent"
                        onClick={() => onOpenRecent(file.path)}
                      >
                        <img alt="" className="size-4 shrink-0" draggable={false} src={fileTinyIcon} />
                        <span className="truncate">{file.name}</span>
                      </DropdownMenuItem>
                    </HintTooltip>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <HintTooltip label={saveHint} side="right">
              <DropdownMenuItem
                // A disabled item is `pointer-events: none`, which would leave
                // the tooltip with no hover to open on.
                className="data-disabled:pointer-events-auto"
                data-action="save"
                disabled={!canSave}
                onClick={onSave}
              >
                <Save />
                {t("annotate.save")}
                <DropdownMenuShortcut>
                  {formatShortcut(shortcuts.save)}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            </HintTooltip>
            <DropdownMenuItem
              data-action="save-as"
              disabled={!onSaveAs}
              onClick={onSaveAs}
            >
              <Upload />
              {t("menu.saveAs")}
              <DropdownMenuShortcut>
                {formatShortcut(shortcuts.saveAs)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-action="save-all"
              disabled={!canSaveAll}
              onClick={onSaveAll}
            >
              <SaveAll />
              {t("menu.saveAll")}
              <DropdownMenuShortcut>
                {formatShortcut(shortcuts.saveAll)}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              data-action="export"
              disabled={!onExport}
              onClick={onExport}
            >
              <FileArchive />
              {t("archiveExport.title")}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-action="close-all"
              disabled={!canCloseAll}
              onClick={onCloseAll}
            >
              <SquareX />
              {t("menu.closeAll")}
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuGroup>
            <DropdownMenuItem
              data-action="settings"
              onClick={() => showSettings("appearance")}
            >
              <Settings />
              {t("settings.open")}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-action="about"
              onClick={() => showSettings("about")}
            >
              <Info />
              {t("settings.about")}
            </DropdownMenuItem>
            {/* `close`, unlike `destroy`, emits close-requested, so App's
                unsaved-work guard gets to stop it and ask. */}
            <DropdownMenuItem
              data-action="exit"
              onClick={() => void getCurrentWindow().close()}
            >
              <LogOut />
              {t("menu.exit")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog
        onOpenChange={setSettingsOpen}
        onSectionChange={setSection}
        open={settingsOpen}
        section={section}
      />
    </>
  )
}
