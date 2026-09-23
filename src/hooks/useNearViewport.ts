import { useEffect, useRef, useState, type RefObject } from "react"

type NearViewportOptions = {
  /** Disconnect completely while compositor geometry differs from layout. */
  paused?: boolean
  retainExited?: boolean
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
  {
    paused = false,
    retainExited = false,
    retainSelection = false,
  }: NearViewportOptions = {},
) {
  const [isNearViewport, setIsNearViewport] = useState(false)
  const intersectingRef = useRef(false)

  useEffect(() => {
    const element = ref.current

    // A compositor-only zoom moves the page without changing its layout box;
    // freezing the window keeps mount/evict work off the gesture's critical path.
    if (!element || paused) {
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

    const settleMountedState = (intersecting: boolean) => {
      intersectingRef.current = intersecting
      setIsNearViewport(
        (mounted) =>
          intersecting ||
          (retainExited && mounted) ||
          selectionTouchesElement(),
      )
    }

    return observeNearViewport(element, rootMargin, settleMountedState)
  }, [paused, ref, retainExited, retainSelection, rootMargin])

  useEffect(() => {
    const element = ref.current

    // Only a selection-retained offscreen surface needs this; a document
    // listener per page would recreate the scale problem this hook avoids.
    if (
      !element ||
      paused ||
      !retainSelection ||
      retainExited ||
      intersectingRef.current ||
      !isNearViewport
    ) {
      return
    }

    const handleSelectionChange = () => {
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
  }, [isNearViewport, paused, ref, retainExited, retainSelection])

  return isNearViewport
}
