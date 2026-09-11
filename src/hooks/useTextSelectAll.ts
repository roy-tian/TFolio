import { useCallback, useEffect, useState } from "react"

import { isTypingTarget } from "@/lib/contextMenu"

type UseTextSelectAllOptions = {
  active: boolean
  onCopy: () => void
}

/**
 * App state rather than a document range, which could span only the pages
 * virtualisation keeps mounted; CSS draws the highlight, PDFium the copy.
 */
export function useTextSelectAll({ active, onCopy }: UseTextSelectAllOptions) {
  const [selectedAll, setSelectedAll] = useState(false)

  const selectAll = useCallback(() => setSelectedAll(true), [])

  useEffect(() => {
    if (!active) {
      setSelectedAll(false)
    }
  }, [active])

  useEffect(() => {
    if (!selectedAll) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedAll(false)

        return
      }

      if (
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "c" ||
        (!event.ctrlKey && !event.metaKey) ||
        // A field reached by the keyboard alone still holds its own copy; a
        // pointer landing in one has already ended this selection below.
        isTypingTarget(event.target)
      ) {
        return
      }

      event.preventDefault()

      // Consumed on every repeat, but answered once: a held key would start the
      // whole document's extraction again for each one.
      if (!event.repeat) {
        onCopy()
      }
    }

    // A primary press starts a selection of its own; any other button asks
    // about this one, as does a press in the menu a right-click opened.
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        (event.target instanceof Element &&
          event.target.closest("[role='menu']"))
      ) {
        return
      }

      setSelectedAll(false)
    }

    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("pointerdown", handlePointerDown)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("pointerdown", handlePointerDown)
    }
  }, [onCopy, selectedAll])

  return { selectAll, selectedAll }
}
