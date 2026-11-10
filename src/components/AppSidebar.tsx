import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { GalleryVertical, ListTree, PanelLeft } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useSidebar } from "@/hooks/useSidebar"
import { hasLayerOverWorkspace } from "@/lib/contextMenu"
import {
  clampSidebarWidth,
  isSidebarPanel,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STEP,
  type SidebarPanel,
} from "@/lib/sidebar"
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

/** Which of a document's two panels the sidebar shows. A document of several
    files shows them, with their bookmarks, where the bookmarks would be. */
export function SidebarPanelSwitch({
  bookmarksApply,
  files = false,
  panel,
}: {
  bookmarksApply: boolean
  files?: boolean
  panel: SidebarPanel
}) {
  const { t } = useTranslation()
  const sidebar = useSidebar()

  return (
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
        const label =
          option.value === "bookmarks" && files ? t("sidebar.files") : t(option.labelKey)
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
  )
}

/**
 * The sidebar's right edge, dragged or arrowed to widen it: wide, its pages
 * flow into columns. Double-click goes back to the opening width. The drag
 * sets the workspace root's width itself, frame by frame, and settles it in
 * the window's state only on release, so App renders once per drag.
 */
function SidebarResizeHandle() {
  const { t } = useTranslation()
  const sidebar = useSidebar()
  const [resizing, setResizing] = useState(false)
  // The drag under way, ended unsettled if the sidebar goes before its release:
  // hidden by its shortcut, or turned into an overlay by a narrowing window.
  const abortRef = useRef<(() => void) | null>(null)
  const { persistWidth, reserved, setWidth } = sidebar

  useEffect(() => () => abortRef.current?.(), [])

  const shownWidth = (handle: HTMLElement) =>
    handle.closest<HTMLElement>("[data-slot=app-sidebar]")?.getBoundingClientRect().width ??
    SIDEBAR_MIN_WIDTH

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget
    const root = handle.closest<HTMLElement>("[data-sidebar]")

    if (event.button !== 0 || !root) {
      return
    }

    // No text selection, and no press on the pages beside it.
    event.preventDefault()

    const startX = event.clientX
    const startWidth = shownWidth(handle)
    const before = {
      chosen: root.style.getPropertyValue("--sidebar-chosen"),
      marked: root.hasAttribute("data-sidebar-width"),
      reserved: root.style.getPropertyValue("--sidebar-reserved"),
    }
    let width = startWidth
    let frame = 0

    const apply = () => {
      frame = 0
      root.setAttribute("data-sidebar-width", "")
      root.style.setProperty("--sidebar-chosen", `${width}px`)
      root.style.setProperty("--sidebar-reserved", `${reserved}px`)
    }
    const move = (moved: PointerEvent) => {
      width = clampSidebarWidth(startWidth + moved.clientX - startX, window.innerWidth, reserved)

      if (!frame) {
        frame = requestAnimationFrame(apply)
      }
    }
    const finish = (commit: boolean) => {
      abortRef.current = null
      cancelAnimationFrame(frame)
      document.removeEventListener("pointermove", move)
      document.removeEventListener("pointerup", release)
      document.removeEventListener("pointercancel", cancel)
      document.removeEventListener("keydown", escape, true)
      setResizing(false)

      if (commit && width !== startWidth) {
        apply()
        setWidth(width)
        return
      }

      // Back as React last left the root, which then has nothing to undo.
      root.toggleAttribute("data-sidebar-width", before.marked)
      root.style.setProperty("--sidebar-chosen", before.chosen)
      root.style.setProperty("--sidebar-reserved", before.reserved)
    }
    const release = () => finish(true)
    const cancel = () => finish(false)
    const escape = (pressed: KeyboardEvent) => {
      if (pressed.key === "Escape") {
        // Only the drag ends: an overlay would otherwise close under it.
        pressed.preventDefault()
        pressed.stopPropagation()
        finish(false)
      }
    }

    // Captured so the pages under a fast pointer take none of its moves; they
    // still bubble to the document, where a pointer never captured is heard too.
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // Only a pointer that is down can be captured.
    }

    document.addEventListener("pointermove", move)
    document.addEventListener("pointerup", release)
    document.addEventListener("pointercancel", cancel)
    document.addEventListener("keydown", escape, true)
    abortRef.current = cancel
    setResizing(true)
  }

  const step = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0

    if (direction === 0) {
      return
    }

    event.preventDefault()
    setWidth(
      clampSidebarWidth(
        shownWidth(event.currentTarget) + direction * SIDEBAR_WIDTH_STEP,
        window.innerWidth,
        reserved,
      ),
      false,
    )
  }

  // As the window shows it: a stored width past the window's room is clamped.
  const widest = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(window.innerWidth - reserved))

  return (
    <div
      aria-label={t("sidebar.resize")}
      aria-orientation="vertical"
      aria-valuemax={widest}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuenow={Math.min(widest, sidebar.width ?? SIDEBAR_MIN_WIDTH)}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-primary/50 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 data-resizing:after:opacity-100"
      data-resizing={resizing ? "" : undefined}
      data-slot="sidebar-resize"
      onDoubleClick={() => setWidth(null)}
      onKeyDown={step}
      onKeyUp={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          persistWidth()
        }
      }}
      onPointerDown={startDrag}
      role="separator"
      tabIndex={0}
    />
  )
}

type AppSidebarProps = {
  children?: ReactNode
  macOS: boolean
  /** The second row: what the rest of the column shows. */
  switcher?: ReactNode
}

/** The window's left column: its first row is the title bar's, the second
    switches what the rest of it shows. */
export function AppSidebar({ children, macOS, switcher }: AppSidebarProps) {
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
    // reach the menu, not take the sidebar away.
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
        <SidebarToggle />
      </div>
      <div className="flex h-(--document-tabs-height) shrink-0 items-center justify-center border-b px-2">
        {switcher}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <SidebarResizeHandle />
    </aside>
  )
}
