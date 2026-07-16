import { useEffect, useState, type RefObject } from "react"

/**
 * Whether `ref`'s element has scrolled within `rootMargin` of the viewport.
 * Pages and thumbnails use this to defer their render until the reader is close
 * enough to see them, so opening a long document costs a few renders, not one
 * per page.
 */
export function useNearViewport(
  ref: RefObject<Element | null>,
  rootMargin = "800px 0px",
) {
  const [isNearViewport, setIsNearViewport] = useState(false)

  useEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    if (!("IntersectionObserver" in window)) {
      setIsNearViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setIsNearViewport(entries.some((entry) => entry.isIntersecting))
      },
      { rootMargin },
    )

    observer.observe(element)

    return () => observer.disconnect()
  }, [ref, rootMargin])

  return isNearViewport
}
