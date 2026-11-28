/**
 * The reader's sidebar width, laid on the few elements it places rather than
 * on the workspace root: an inherited property changed there restyled every
 * element in the window, 40–60 ms a double-click in Chromium and as much each
 * frame of a drag. Each placed element works its width and inset out for
 * itself (`index.css`) from properties no descendant inherits. Kept outside
 * React state too, so a new width renders none of the window's components.
 */
export type SidebarWidthStore = {
  /** The reader's width before the window clamps it, or null for the
      opening width. */
  get: () => number | null
  /** Settles a width, and tells those that show it. */
  set: (width: number | null) => void
  /** The room the sidebar leaves the rest of the window. */
  setReserved: (reserved: number) => void
  /** Lays the sidebar out at `width` without settling it: a drag's frames,
      and the width it goes back to when let go of unsettled. */
  show: (width: number | null) => void
  /** Places `element` by the sidebar until the returned release. */
  size: (element: HTMLElement) => () => void
  subscribe: (listener: () => void) => () => void
}

export function createSidebarWidthStore(width: number | null, reserved: number): SidebarWidthStore {
  let settled = width
  let shown = width
  let room = reserved
  const elements = new Set<HTMLElement>()
  const listeners = new Set<() => void>()

  const lay = (element: HTMLElement) => {
    element.toggleAttribute("data-sidebar-width", shown !== null)
    element.style.setProperty("--sidebar-chosen", `${shown ?? 0}px`)
    element.style.setProperty("--sidebar-reserved", `${room}px`)
  }
  const layAll = () => {
    for (const element of elements) {
      lay(element)
    }
  }
  const show = (next: number | null) => {
    if (next !== shown) {
      shown = next
      layAll()
    }
  }

  return {
    get: () => settled,
    set: (next) => {
      show(next)

      if (next !== settled) {
        settled = next

        for (const listener of listeners) {
          listener()
        }
      }
    },
    setReserved: (next) => {
      if (next !== room) {
        room = next
        layAll()
      }
    },
    show,
    size: (element) => {
      element.setAttribute("data-sidebar-sized", "")
      elements.add(element)
      lay(element)

      return () => {
        elements.delete(element)
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}
