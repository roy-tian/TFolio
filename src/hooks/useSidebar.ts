import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"

import {
  readStoredSidebarOpen,
  readStoredSidebarPanel,
  sidebarDockMinWidth,
  sidebarMode,
  storeSidebarOpen,
  storeSidebarPanel,
  type SidebarMode,
  type SidebarPanel,
} from "@/lib/sidebar"

export type SidebarState = {
  /** Lets an overlay go; a docked sidebar stays until the reader hides it. */
  dismiss: () => void
  mode: SidebarMode
  panel: SidebarPanel
  setPanel: (panel: SidebarPanel) => void
  toggle: () => void
}

export const SidebarContext = createContext<SidebarState | null>(null)

export function useSidebar() {
  const sidebar = useContext(SidebarContext)

  if (!sidebar) {
    throw new Error("useSidebar needs a SidebarContext provider")
  }

  return sidebar
}

function useMediaQuery(query: string) {
  const list = useMemo(() => window.matchMedia(query), [query])
  const subscribe = useCallback(
    (onChange: () => void) => {
      list.addEventListener("change", onChange)

      return () => list.removeEventListener("change", onChange)
    },
    [list],
  )

  return useSyncExternalStore(subscribe, () => list.matches)
}

/** The window's one sidebar state, which every tab's sidebar shows: it is how
    the reader lays the window out, not a property of a document. */
export function useSidebarState(macOS: boolean): SidebarState {
  const docked = useMediaQuery(`(min-width: ${sidebarDockMinWidth(macOS)}px)`)
  const [open, setOpen] = useState(readStoredSidebarOpen)
  const [panel, setPanelState] = useState(readStoredSidebarPanel)
  // Never stored: a narrow window opens the sidebar over the pages only for
  // the moment it takes to pick one.
  const [peeking, setPeeking] = useState(false)

  if (docked && peeking) {
    setPeeking(false)
  }

  const mode = sidebarMode(open, docked, peeking)

  const toggle = useCallback(() => {
    if (docked) {
      setOpen(!open)
      storeSidebarOpen(!open)
    } else {
      setPeeking((previous) => !previous)
    }
  }, [docked, open])

  const dismiss = useCallback(() => setPeeking(false), [])

  const setPanel = useCallback((next: SidebarPanel) => {
    setPanelState(next)
    storeSidebarPanel(next)
  }, [])

  return useMemo(
    () => ({ dismiss, mode, panel, setPanel, toggle }),
    [dismiss, mode, panel, setPanel, toggle],
  )
}
