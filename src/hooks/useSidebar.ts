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
  sidebarDockMinWidth,
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
  /** The shown tab's sidebar has nothing to list: it gives its column up
      until it has, opening over the pages only when asked, as in a narrow
      window. */
  setVacant: (vacant: boolean) => void
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
export function useSidebarState(macOS: boolean): SidebarState {
  const roomy = useMediaQuery(`(min-width: ${sidebarDockMinWidth(macOS)}px)`)
  // Never stored: it is the shown document's state, not the reader's choice.
  const [vacant, setVacantState] = useState(false)
  const docked = roomy && !vacant
  const [open, setOpen] = useState(readStoredSidebarOpen)
  const vacantRef = useRef(vacant)
  // Whether a docked column is what vacancy takes away and gives back.
  const dockableRef = useRef(roomy && open)

  dockableRef.current = roomy && open

  // The viewer's left edge moves with the column, as when the reader hides
  // it: warned first, the reading view keeps its place under the page grid.
  const setVacant = useCallback((next: boolean) => {
    if (next === vacantRef.current) {
      return
    }

    vacantRef.current = next

    if (dockableRef.current) {
      window.dispatchEvent(new Event(VIEWER_WILL_MOVE_EVENT))
    }

    setVacantState(next)
  }, [])
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

  const reserved = sidebarReservedWidth(macOS, docked)

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
      setVacant,
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
