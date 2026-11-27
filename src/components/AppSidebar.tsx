import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { ChevronDown, GalleryVertical, ListTree, PanelLeft } from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Toggle } from "@/components/ui/toggle"
import { useSidebar } from "@/hooks/useSidebar"
import { hasLayerOverWorkspace } from "@/lib/contextMenu"
import {
  clampSidebarWidth,
  isSidebarPanel,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STEP,
  sidebarDoubleClick,
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
  { icon: ListTree, labelKey: "sidebar.outline", value: "bookmarks" },
] as const

/** Which of a document's panels the sidebar shows: every panel stays in one
    menu so adding more never crowds the opening width, and the toggle beside it
    keeps its place across docked, overlay and hidden states. */
export function SidebarPanelSwitch({ panel }: { panel: SidebarPanel }) {
  const { t } = useTranslation()
  const sidebar = useSidebar()
  const labelRef = useRef<HTMLSpanElement>(null)
  const current =
    panelOptions.find((option) => option.value === panel) ?? panelOptions[0]
  const CurrentIcon = current.icon
  const currentLabel = t(current.labelKey)

  return (
    <DropdownMenu>
      {/* Only a cut-short name has more to say: a tooltip repeating the whole
          label would sit over the panel's own bar for nothing. */}
      <ToolbarTooltip cutShort={labelRef} label={currentLabel}>
        <DropdownMenuTrigger
          render={
            <Button
              className="max-w-full min-w-0 shrink gap-1.5 border-input bg-transparent px-2 dark:bg-transparent"
              data-panel={panel}
              data-slot="sidebar-panel-switch"
              size="sm"
              variant="outline"
            />
          }
        >
          <CurrentIcon className="shrink-0" />
          <span className="min-w-0 truncate" ref={labelRef}>
            {currentLabel}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
      </ToolbarTooltip>
      <DropdownMenuContent
        align="end"
        aria-label={t("sidebar.panels")}
        className="w-auto min-w-36"
      >
        <DropdownMenuRadioGroup
          onValueChange={(next) => {
            if (isSidebarPanel(next)) {
              sidebar.setPanel(next)
            }
          }}
          value={panel}
        >
          {panelOptions.map((option) => {
            const OptionIcon = option.icon

            return (
              <DropdownMenuRadioItem
                data-sidebar-panel={option.value}
                key={option.value}
                value={option.value}
              >
                <OptionIcon />
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The sidebar's right edge, dragged or arrowed to widen it: wide, its pages
 * stand in rows of several. Double-click goes back to the opening width, and
 * from there, docked, out to as wide as the pages beside it, or as wide as the
 * window lets it. The drag
 * sets the workspace root's width itself, frame by frame, and settles it in
 * the window's state only on release, so App renders once per drag.
 */
function SidebarResizeHandle() {
  const { t } = useTranslation()
  const sidebar = useSidebar()
  const [resizing, setResizing] = useState(false)
  const [, setMeasuredWindowWidth] = useState(() => window.innerWidth)
  const syncWindowWidth = () => setMeasuredWindowWidth(window.innerWidth)
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

  const viewportWidth = window.innerWidth
  // As the window shows it: a stored width past the window's room is clamped.
  const widest = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(viewportWidth - reserved))
  const shown =
    sidebar.width === null
      ? SIDEBAR_MIN_WIDTH
      : clampSidebarWidth(sidebar.width, viewportWidth, reserved)
  const doubleClick = sidebarDoubleClick(sidebar.mode, shown, viewportWidth, reserved)
  const hintLabel =
    doubleClick?.action === "restore" ? t("sidebar.resizeRestore") : t("sidebar.resizeExpand")

  return (
    <HintTooltip
      disabled={resizing || doubleClick === null}
      label={hintLabel}
      side="right"
      trackCursorAxis="y"
    >
      <div
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemax={widest}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuenow={shown}
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-primary/50 after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 data-resizing:after:opacity-100"
        data-resizing={resizing ? "" : undefined}
        data-slot="sidebar-resize"
        onDoubleClick={(event) => {
          const next = sidebarDoubleClick(
            sidebar.mode,
            shownWidth(event.currentTarget),
            window.innerWidth,
            reserved,
          )

          if (next) {
            setWidth(next.width)
          }
        }}
        onFocus={syncWindowWidth}
        onKeyDown={step}
        onKeyUp={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            persistWidth()
          }
        }}
        onPointerDown={startDrag}
        onPointerEnter={syncWindowWidth}
        role="separator"
        tabIndex={0}
      />
    </HintTooltip>
  )
}

type AppSidebarProps = {
  children?: ReactNode
  /** Along the bottom, level with the status bar beside it. */
  footer?: ReactNode
  macOS: boolean
  /** At the far end of the first row: what the rest of the column shows. */
  switcher?: ReactNode
}

/** The window's left column: its first row is the title bar's, the toggle at
    one end and, at the other, the switch for what the rest of it shows. */
export function AppSidebar({ children, footer, macOS, switcher }: AppSidebarProps) {
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
          // As the toolbar beside it: its line under the row, and pb-px to
          // keep the content box even, so the toggle stands at one height
          // whichever of the two rows holds it.
          "flex h-(--toolbar-height) shrink-0 items-center gap-2 border-b px-2 pb-px",
          // The traffic lights sit over this corner of the window.
          macOS && "pl-[76px]",
        )}
        data-tauri-drag-region="deep"
      >
        <SidebarToggle />
        {switcher ? <div className="ml-auto flex min-w-0 justify-end">{switcher}</div> : null}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      {footer ? (
        // As the status bar: its line over the row, and pb-px to keep the
        // control at the bar's height.
        <div
          className="flex h-(--status-bar-height) shrink-0 items-center border-t px-2 pb-px"
          data-slot="sidebar-footer"
        >
          {footer}
        </div>
      ) : null}
      <SidebarResizeHandle />
    </aside>
  )
}
