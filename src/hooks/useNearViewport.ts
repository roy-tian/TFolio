import {
  createContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react"

type HoldFlags = { paused: boolean; retainExited: boolean }

/**
 * A viewer's gesture state — a zoom preview holding the page window still, a
 * selection drag keeping the pages it has crossed — read by each page's
 * observer when it fires. Kept out of props: a flag flipping per gesture
 * would re-render every page and re-observe each one.
 */
export class ViewportHold {
  private flags: HoldFlags = { paused: false, retainExited: false }
  private readonly listeners = new Set<() => void>()

  get paused() {
    return this.flags.paused
  }

  get retainExited() {
    return this.flags.retainExited
  }

  set(next: HoldFlags) {
    if (
      next.paused === this.flags.paused &&
      next.retainExited === this.flags.retainExited
    ) {
      return
    }

    this.flags = next

    for (const listener of this.listeners) {
      listener()
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const ViewportHoldContext = createContext<ViewportHold | null>(null)

type NearViewportOptions = {
  /** The viewer's gesture flags; none holds the answer back. */
  hold?: ViewportHold | null
  retainSelection?: boolean
}

type SharedObserver = {
  callbacks: Map<Element, (intersecting: boolean) => void>
  observer: IntersectionObserver
}

const observers = new Map<Element | null, Map<string, SharedObserver>>()

function observeNearViewport(
  element: Element,
  rootMargin: string,
  onChange: (intersecting: boolean) => void,
) {
  // The pages scroll inside the viewer, not the window. Rooting the observer
  // there makes its margin reach pages before the viewer clips them.
  const root = element.closest("[data-pdf-scroll-root]")
  let margins = observers.get(root)

  if (!margins) {
    margins = new Map()
    observers.set(root, margins)
  }

  let shared = margins.get(rootMargin)

  if (!shared) {
    const callbacks = new Map<Element, (intersecting: boolean) => void>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          callbacks.get(entry.target)?.(entry.isIntersecting)
        }
      },
      { root, rootMargin },
    )
    shared = { callbacks, observer }
    margins.set(rootMargin, shared)
  }

  shared.callbacks.set(element, onChange)
  shared.observer.observe(element)

  return () => {
    shared.observer.unobserve(element)
    shared.callbacks.delete(element)

    if (shared.callbacks.size === 0) {
      shared.observer.disconnect()
      margins.delete(rootMargin)

      if (margins.size === 0) {
        observers.delete(root)
      }
    }
  }
}

export function useNearViewport(
  ref: RefObject<Element | null>,
  rootMargin = "800px 0px",
  { hold = null, retainSelection = false }: NearViewportOptions = {},
) {
  const [isNearViewport, setIsNearViewport] = useState(false)
  const intersectingRef = useRef(false)
  const mountedRef = useRef(false)
  // A page kept mounted off screen — by a selection or a hold — changes no
  // state as it leaves, yet the selection listener below must re-check then.
  const [offscreenTick, setOffscreenTick] = useState(0)

  useEffect(() => {
    mountedRef.current = isNearViewport
  }, [isNearViewport])

  useEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true)
      return
    }

    const selectionTouchesElement = () => {
      const selection = window.getSelection()

      return Boolean(
        retainSelection &&
          selection &&
          !selection.isCollapsed &&
          selection.rangeCount > 0 &&
          selection.containsNode(element, true),
      )
    }

    // A compositor-only zoom moves the page without changing its layout box;
    // holding the answer keeps mount/evict work off the gesture's critical path.
    const settleMountedState = (intersecting: boolean) => {
      intersectingRef.current = intersecting

      if (hold?.paused) {
        return
      }

      setIsNearViewport(
        (mounted) =>
          intersecting ||
          (Boolean(hold?.retainExited) && mounted) ||
          selectionTouchesElement(),
      )

      if (retainSelection && !intersecting && mountedRef.current) {
        setOffscreenTick((tick) => tick + 1)
      }
    }

    const stopObserving = observeNearViewport(
      element,
      rootMargin,
      settleMountedState,
    )
    // A hold let go: settle on where the page stands now.
    const stopHolding = hold?.subscribe(() => {
      settleMountedState(intersectingRef.current)
    })

    return () => {
      stopObserving()
      stopHolding?.()
    }
  }, [hold, ref, retainSelection, rootMargin])

  useEffect(() => {
    const element = ref.current

    // Only a selection-retained offscreen surface needs this; a document
    // listener per page would recreate the scale problem this hook avoids.
    if (
      !element ||
      hold?.paused ||
      !retainSelection ||
      hold?.retainExited ||
      intersectingRef.current ||
      !isNearViewport
    ) {
      return
    }

    const handleSelectionChange = () => {
      // Registered off screen, the page may have come back since, or a hold
      // begun: neither changes state that would have taken this listener down.
      if (hold?.paused || hold?.retainExited || intersectingRef.current) {
        return
      }

      const selection = window.getSelection()
      const stillSelected = Boolean(
        selection &&
          !selection.isCollapsed &&
          selection.rangeCount > 0 &&
          selection.containsNode(element, true),
      )

      if (!stillSelected) {
        setIsNearViewport(false)
      }
    }

    document.addEventListener("selectionchange", handleSelectionChange)

    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [hold, isNearViewport, offscreenTick, ref, retainSelection])

  return isNearViewport
}
