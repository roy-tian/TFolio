import { useCallback, useEffect, useState } from "react"

import {
  emptySelection,
  selectionAfterClick,
  selectionOfAllPages,
  type SelectionModifiers,
  type ThumbnailSelection,
} from "@/lib/thumbnailSelection"

type UseThumbnailSelectionOptions = {
  active: boolean
  numPages: number
}

/**
 * Gesture logic lives in `lib/thumbnailSelection`; this owns the state and the
 * clearing events no click carries — Esc, leaving, structure changes.
 */
export function useThumbnailSelection({
  active,
  numPages,
}: UseThumbnailSelectionOptions) {
  const [selection, setSelection] = useState<ThumbnailSelection>(emptySelection)

  const clear = useCallback(() => {
    setSelection(emptySelection)
  }, [])

  const selectAll = useCallback(() => {
    setSelection(selectionOfAllPages(numPages))
  }, [numPages])

  const select = useCallback(
    (pageNumber: number, modifiers: SelectionModifiers) => {
      setSelection((current) =>
        selectionAfterClick(current, pageNumber, modifiers),
      )
    },
    [],
  )

  useEffect(() => {
    if (!active) {
      setSelection(emptySelection)
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelection(emptySelection)
      }
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [active])

  return { clear, select, selectAll, selectedPages: selection.pages }
}
