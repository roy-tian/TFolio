import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react"

import {
  clampSidebarWidth,
  readStoredSidebarOpen,
  readStoredSidebarPanel,
  readStoredSidebarWidth,
  SIDEBAR_DOCK_MIN_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarMode,
  sidebarReservedWidth,
  storeSidebarOpen,
  storeSidebarPanel,
  storeSidebarWidth,
  type SidebarMode,
  type SidebarPanel,
} from "@/lib/sidebar"
import { createSidebarWidthStore, type SidebarWidthStore } from "@/lib/sidebarWidth"
import { VIEWER_WILL_MOVE_EVENT } from "@/lib/viewerViewport"

export type SidebarState = {
  /** Lets an overlay go; a docked sidebar stays until the reader hides it. */
  dismiss: () => void
  mode: SidebarMode
  panel: SidebarPanel
  /** The room the sidebar leaves the rest of the window, in CSS pixels. */
  reserved: number
  setPanel: (panel: SidebarPanel) => void
  /** Stores the width last set without storing. */
  persistWidth: () => void
  /** Calls `listener` each time the reader widens the docked sidebar to half
      the window or more — a drag let go, an arrow, a double-click — so the
      pages beside it, left half or less, can give up book view. A window's own
      resize is none. Told inside the reader's event, before the next paint. */
  onWidenedToHalf: (listener: () => void) => () => void
  /** Settles a width the reader chose; null goes back to the opening width.
      `persist: false` leaves the file alone until `persistWidth`, so a held
      arrow key writes the settings once, not at the key's repeat rate. */
  setWidth: (width: number | null, persist?: boolean) => void
  toggle: () => void
  /** The width, which only the elements it places follow
      (`SidebarWidthContext`). */
  widthStore: SidebarWidthStore
}

export const SidebarContext = createContext<SidebarState | null>(null)

/** The width alone, which never changes identity: what reads it renders on
    nothing else the sidebar does. */
export const SidebarWidthContext = createContext<SidebarWidthStore | null>(null)

export function useSidebar() {
  const sidebar = useContext(SidebarContext)

  if (!sidebar) {
    throw new Error("useSidebar needs a SidebarContext provider")
  }

  return sidebar
}

function useSidebarWidthStore() {
  const store = useContext(SidebarWidthContext)

  if (!store) {
    throw new Error("the sidebar's width needs a SidebarWidthContext provider")
  }

  return store
}

/** The reader's width, for what shows it: null is the opening width. */
export function useSidebarWidth() {
  const store = useSidebarWidthStore()

  return useSyncExternalStore(store.subscribe, store.get)
}

/** A ref placing its element by the sidebar, for its `--sidebar-width` and
    `--sidebar-inset`; `own` is given the element too. */
export function useSidebarSized<T extends HTMLElement>(own?: RefObject<T | null>) {
  const store = useSidebarWidthStore()

  return useCallback(
    (element: T | null) => {
      if (own) {
        own.current = element
      }

      if (!element) {
        return undefined
      }

      const release = store.size(element)

      return () => {
        if (own) {
          own.current = null
        }

        release()
      }
    },
    [own, store],
  )
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
  const [widthStore] = useState(() =>
    createSidebarWidthStore(readStoredSidebarWidth(), sidebarReservedWidth(docked)),
  )
  const [widenListeners] = useState(() => new Set<() => void>())
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

  const reserved = sidebarReservedWidth(docked)

  useLayoutEffect(() => widthStore.setReserved(reserved), [reserved, widthStore])

  const setWidth = useCallback(
    (next: number | null, persist = true) => {
      // As the window shows them, each clamped to its room; the opening width
      // is the narrowest.
      const shown = (chosen: number | null) =>
        chosen === null
          ? SIDEBAR_MIN_WIDTH
          : clampSidebarWidth(chosen, window.innerWidth, reserved)
      const half = window.innerWidth / 2

      const widened = docked && shown(widthStore.get()) < half && shown(next) >= half

      widthStore.set(next)

      if (widened) {
        for (const listener of widenListeners) {
          listener()
        }
      }

      if (persist) {
        storeSidebarWidth(next)
      }
    },
    [docked, reserved, widenListeners, widthStore],
  )

  const onWidenedToHalf = useCallback(
    (listener: () => void) => {
      widenListeners.add(listener)

      return () => {
        widenListeners.delete(listener)
      }
    },
    [widenListeners],
  )

  const persistWidth = useCallback(() => storeSidebarWidth(widthStore.get()), [widthStore])

  return useMemo(
    () => ({
      dismiss,
      mode,
      onWidenedToHalf,
      panel,
      persistWidth,
      reserved,
      setPanel,
      setWidth,
      toggle,
      widthStore,
    }),
    [
      dismiss,
      mode,
      onWidenedToHalf,
      panel,
      persistWidth,
      reserved,
      setPanel,
      setWidth,
      toggle,
      widthStore,
    ],
  )
}
