import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  readStoredFileRows,
  readStoredSidebarOpen,
  readStoredSidebarPanel,
  readStoredSidebarWidth,
  SIDEBAR_DOCK_MIN_WIDTH,
  sidebarMode,
  sidebarReservedWidth,
  storeFileRows,
  storeSidebarOpen,
  storeSidebarPanel,
  storeSidebarWidth,
  type SidebarMode,
  type SidebarPanel,
} from "@/lib/sidebar"
import { VIEWER_WILL_MOVE_EVENT } from "@/lib/viewerViewport"

export type SidebarState = {
  /** Lets an overlay go; a docked sidebar stays until the reader hides it. */
  dismiss: () => void
  /** Whether each file of a document of several starts a row of its own. */
  fileRows: boolean
  mode: SidebarMode
  panel: SidebarPanel
  /** The room the sidebar leaves the rest of the window, in CSS pixels. */
  reserved: number
  setFileRows: (fileRows: boolean) => void
  setPanel: (panel: SidebarPanel) => void
  /** Stores the width last set without storing. */
  persistWidth: () => void
  /** Settles a width the reader chose; null goes back to the opening width.
      `persist: false` leaves the file alone until `persistWidth`, so a held
      arrow key writes the settings once, not at the key's repeat rate. */
  setWidth: (width: number | null, persist?: boolean) => void
  toggle: () => void
  /** The reader's width before the window clamps it, or null for the
      opening width. */
  width: number | null
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
export function useSidebarState(): SidebarState {
  const docked = useMediaQuery(`(min-width: ${SIDEBAR_DOCK_MIN_WIDTH}px)`)
  const [open, setOpen] = useState(readStoredSidebarOpen)
  const [panel, setPanelState] = useState(readStoredSidebarPanel)
  const [width, setWidthState] = useState(readStoredSidebarWidth)
  const [fileRows, setFileRowsState] = useState(readStoredFileRows)
  const widthRef = useRef(width)
  // Never stored: a narrow window opens the sidebar over the pages only for
  // the moment it takes to pick one.
  const [peeking, setPeeking] = useState(false)

  if (docked && peeking) {
    setPeeking(false)
  }

  const mode = sidebarMode(open, docked, peeking)

  const toggle = useCallback(() => {
    if (docked) {
      window.dispatchEvent(new Event(VIEWER_WILL_MOVE_EVENT))
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

  const setWidth = useCallback((next: number | null, persist = true) => {
    widthRef.current = next
    setWidthState(next)

    if (persist) {
      storeSidebarWidth(next)
    }
  }, [])

  const persistWidth = useCallback(() => storeSidebarWidth(widthRef.current), [])

  const setFileRows = useCallback((next: boolean) => {
    setFileRowsState(next)
    storeFileRows(next)
  }, [])

  const reserved = sidebarReservedWidth(docked)

  return useMemo(
    () => ({
      dismiss,
      fileRows,
      mode,
      panel,
      persistWidth,
      reserved,
      setFileRows,
      setPanel,
      setWidth,
      toggle,
      width,
    }),
    [
      dismiss,
      fileRows,
      mode,
      panel,
      persistWidth,
      reserved,
      setFileRows,
      setPanel,
      setWidth,
      toggle,
      width,
    ],
  )
}
