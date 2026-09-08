import { useCallback, useEffect, useState } from "react"

import {
  emptySelection,
  selectionAfterClick,
  selectionOfAllPages,
  type SelectionModifiers,
  type ThumbnailSelection,
} from "@/lib/thumbnailSelection"

type UseThumbnailSelectionOptions = {
  /** Selection only lives in the thumbnail grid; leaving it clears it. */
  active: boolean
  /** What a select-all takes, so the grid's shortcut needs no page list. */
  numPages: number
}

/**
 * Which thumbnails are selected. The gesture logic lives in
 * `lib/thumbnailSelection`; this owns the state, and the clearing that
 * follows from events no click carries — Esc, leaving the grid, and the
 * structure changes the owner reports.
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
