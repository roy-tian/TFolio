import { useCallback, useEffect, useState } from "react"

import { isTypingTarget } from "@/lib/contextMenu"

type UseTextSelectAllOptions = {
  /** Only the visible document's page views hold a selection of their own. */
  active: boolean
  /** Puts the document's text on the clipboard — what the selection is for. */
  onCopy: () => void
}

/**
 * Whether the whole document's text stands selected in the page views.
 *
 * The selection is the app's own rather than a range in the document, which
 * could only ever hold the few pages virtualisation keeps mounted: the layout's
 * CSS draws the highlight from this, and the copy below comes from PDFium.
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
