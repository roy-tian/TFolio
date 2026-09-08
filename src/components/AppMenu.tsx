import { useState } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  AppWindow,
  FilePlus2,
  FolderOpen,
  History,
  Info,
  LogOut,
  Menu,
  Save,
  Settings,
  SquareX,
  Upload,
} from "lucide-react"
import { useTranslation } from "react-i18next"

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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { RecentFile } from "@/lib/recentFiles"

/** The entries that act on the workspace rather than on one document, so the
    home tab's menu and every document's carry the same ones. */
export type AppMenuActions = {
  /** Whether anything is open to close. */
  canCloseAll: boolean
  onCloseAll: () => void
  /** Opens the merge wizard, which builds a document of its own rather than
      touching the one on screen — a workspace action like opening a file. Not
      a menu entry: it is a button, in the document tools' group of the toolbar
      (`MergeWizardButton`), and this bag is how it reaches every header. */
  onMergeWizard: () => void
  onNew: () => void
  onNewWindow: () => void
  onOpen: () => void
  onOpenRecent: (path: string) => void
  /** Read the recent list again as the menu opens: it is the backend's, and a
      document tab's menu would otherwise show whatever the home tab last saw. */
  onRefreshRecent: () => void
  recentFiles: RecentFile[]
}

type AppMenuProps = AppMenuActions & {
  /** Whether the active document may be written back over its own file. */
  canSave?: boolean
  onSave?: () => void
  /** Absent while no document is open, which is what greys the item out. */
  onSaveAs?: () => void
  /** Why saving is unavailable, where the reason is not already on screen. */
  saveHint?: string
}

/**
 * The window's one menu, at the left end of every header: the file actions
 * with no key of their own, the recent list the home tab shows, and the
 * app-level entries under them.
 */
export function AppMenu({
  canCloseAll,
  canSave = false,
  onCloseAll,
  onNew,
  onNewWindow,
  onOpen,
  onOpenRecent,
  onRefreshRecent,
  onSave,
  onSaveAs,
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
                className="text-blue-600 hover:text-blue-700 aria-expanded:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 dark:aria-expanded:text-blue-300"
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
            </DropdownMenuItem>
            <DropdownMenuItem data-action="new-window" onClick={onNewWindow}>
              <AppWindow />
              {t("menu.newWindow")}
            </DropdownMenuItem>
            <DropdownMenuItem data-action="open" onClick={onOpen}>
              <FolderOpen />
              {t("menu.openFile")}
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
                  recentFiles.map((file) => (
                    <HintTooltip key={file.path} label={file.path} side="right">
                      <DropdownMenuItem
                        data-action="recent"
                        onClick={() => onOpenRecent(file.path)}
                      >
                        <span className="truncate">{file.name}</span>
                      </DropdownMenuItem>
                    </HintTooltip>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <HintTooltip label={saveHint} side="right">
              <DropdownMenuItem
                // The hint is only ever set while the item is disabled, and a
                // disabled item is `pointer-events: none` — which would leave
                // the tooltip with no hover to open on.
                className="data-disabled:pointer-events-auto"
                data-action="save"
                disabled={!canSave}
                onClick={onSave}
              >
                <Save />
                {t("annotate.save")}
              </DropdownMenuItem>
            </HintTooltip>
            <DropdownMenuItem
              data-action="save-as"
              disabled={!onSaveAs}
              onClick={onSaveAs}
            >
              <Upload />
              {t("menu.saveAs")}
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
