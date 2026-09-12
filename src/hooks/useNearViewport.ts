import { useEffect, useRef, useState, type RefObject } from "react"

type NearViewportOptions = {
  /** Disconnect completely while compositor geometry differs from layout. */
  paused?: boolean
  retainExited?: boolean
  retainSelection?: boolean
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

    const observer = new IntersectionObserver(
      (entries) => {
        settleMountedState(entries.some((entry) => entry.isIntersecting))
      },
      { rootMargin },
    )

    observer.observe(element)

    return () => {
      observer.disconnect()
    }
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
