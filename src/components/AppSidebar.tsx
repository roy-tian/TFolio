import { useEffect, useRef, type ReactNode } from "react"
import { GalleryVertical, ListTree, PanelLeft } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSidebar } from "@/hooks/useSidebar"
import { hasLayerOverWorkspace } from "@/lib/contextMenu"
import { isSidebarPanel, type SidebarPanel } from "@/lib/sidebar"
import { cn } from "@/lib/utils"

export function SidebarToggle() {
  const { t } = useTranslation()
  const sidebar = useSidebar()
  const shown = sidebar.mode !== "hidden"
  const label = shown ? t("sidebar.hide") : t("sidebar.show")

  return (
    <ToolbarTooltip label={label}>
      <Toggle
        aria-label={label}
        className="size-7 min-w-7 px-0"
        data-slot="sidebar-toggle"
        onPressedChange={sidebar.toggle}
        pressed={shown}
      >
        <PanelLeft />
      </Toggle>
    </ToolbarTooltip>
  )
}

const panelOptions = [
  { icon: GalleryVertical, labelKey: "sidebar.thumbnails", value: "thumbnails" },
  { icon: ListTree, labelKey: "sidebar.bookmarks", value: "bookmarks" },
] as const

type AppSidebarProps = {
  bookmarksApply: boolean
  children?: ReactNode
  macOS: boolean
  /** The app menu, mounted here only while the sidebar shows: the toolbar
      carries it otherwise. */
  menu: ReactNode
  /** Absent where there is no document to show either panel of. */
  panel?: SidebarPanel
}

/** The window's left column: its first row is the title bar's, the second
    switches what the rest shows of the document in the tab. */
export function AppSidebar({
  bookmarksApply,
  children,
  macOS,
  menu,
  panel,
}: AppSidebarProps) {
  const { t } = useTranslation()
  const sidebar = useSidebar()
  const asideRef = useRef<HTMLElement>(null)
  const overlay = sidebar.mode === "overlay"
  const { dismiss } = sidebar

  useEffect(() => {
    if (!overlay) {
      return
    }

    // Every tab mounts a sidebar; a background tab's has no box, and every
    // press would land outside it, so only the shown one may dismiss.
    const shown = () => (asideRef.current?.getClientRects().length ?? 0) > 0

    // An open menu is a portal outside the sidebar: a press inside it must
    // reach the menu, not take the sidebar — and its menu — away.
    const dismissOutside = (event: PointerEvent) => {
      if (
        shown() &&
        event.target instanceof Node &&
        !asideRef.current?.contains(event.target) &&
        !hasLayerOverWorkspace()
      ) {
        dismiss()
      }
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && shown() && !hasLayerOverWorkspace()) {
        dismiss()
      }
    }

    document.addEventListener("pointerdown", dismissOutside, true)
    document.addEventListener("keydown", dismissOnEscape)

    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [dismiss, overlay])

  if (sidebar.mode === "hidden") {
    return null
  }

  return (
    <aside
      className={cn(
        "app-sidebar fixed inset-y-0 left-0 z-50 flex w-(--sidebar-width) flex-col border-r text-sidebar-foreground",
        overlay && "shadow-xl",
      )}
      data-sidebar-mode={sidebar.mode}
      data-slot="app-sidebar"
      ref={asideRef}
    >
      <div
        className={cn(
          "flex h-(--toolbar-height) shrink-0 items-center gap-1 px-2",
          // The traffic lights sit over this corner of the window.
          macOS && "pl-[76px]",
        )}
        data-tauri-drag-region="deep"
      >
        {menu}
        <SidebarToggle />
      </div>
      <div className="flex h-(--document-tabs-height) shrink-0 items-center justify-center border-b px-2">
        {panel ? (
          <ToggleGroup
            aria-label={t("sidebar.panels")}
            onValueChange={([next]) => {
              // Pressing the shown panel again would empty the group; one
              // panel always shows.
              if (isSidebarPanel(next)) {
                sidebar.setPanel(next)
              }
            }}
            size="sm"
            spacing={0}
            value={[panel]}
            variant="outline"
          >
            {panelOptions.map((option) => {
              const Icon = option.icon
              const label = t(option.labelKey)
              const unavailable = option.value === "bookmarks" && !bookmarksApply

              return (
                <ToolbarTooltip
                  key={option.value}
                  label={unavailable ? t("sidebar.noBookmarks") : label}
                >
                  <ToggleGroupItem
                    aria-label={label}
                    className="gap-1.5 px-3"
                    disabled={unavailable}
                    value={option.value}
                  >
                    <Icon />
                    {label}
                  </ToggleGroupItem>
                </ToolbarTooltip>
              )
            })}
          </ToggleGroup>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </aside>
  )
}
