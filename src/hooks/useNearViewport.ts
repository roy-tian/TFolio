import { useEffect, useRef, useState, type RefObject } from "react"

type NearViewportOptions = {
  /** Disconnect completely while compositor geometry differs from layout. */
  paused?: boolean
  /** Keep surfaces that were already mounted, while still mounting new entries. */
  retainExited?: boolean
  /** Keep an offscreen surface while the browser selection still touches it. */
  retainSelection?: boolean
}

/**
 * Whether `ref`'s element has scrolled within `rootMargin` of the viewport.
 * Pages and thumbnails use this to defer their render until the reader is close
 * enough to see them, so opening a long document costs a few renders, not one
 * per page.
 */
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

    // A compositor-only zoom moves the page visually without changing its
    // layout box. Freeze the current virtualisation window for that short
    // gesture: mounting or evicting a canvas mid-preview would put the expensive
    // work we are avoiding straight back onto the gesture's critical path.
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

    // Only an offscreen surface retained by the finished native selection needs
    // to hear selection changes. Attaching this to every page would turn a drag
    // into one document listener per page — the scale problem this hook avoids.
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
