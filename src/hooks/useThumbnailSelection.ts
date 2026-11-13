import { useCallback, useEffect, useRef, useState } from "react"

import type { CurrentPage } from "@/hooks/useCurrentPage"
import {
  emptySelection,
  selectionAfterClick,
  selectionAfterGroupClick,
  selectionOfAllPages,
  selectionWithout,
  type SelectionModifiers,
  type ThumbnailSelection,
} from "@/lib/thumbnailSelection"

type UseThumbnailSelectionOptions = {
  active: boolean
  currentPage: CurrentPage
  numPages: number
}

/**
 * Gesture logic lives in `lib/thumbnailSelection`; this owns the state and the
 * clearing events no click carries — Esc, leaving, structure changes, and
 * reading on from a page a plain click chose.
 */
export function useThumbnailSelection({
  active,
  currentPage,
  numPages,
}: UseThumbnailSelectionOptions) {
  const [selection, setSelection] = useState<ThumbnailSelection>(emptySelection)
  // A plain click goes to its page and chooses it only while it is the page
  // being read, which its jump holds (`pickReadingPage`): what stays chosen as
  // the reader reads on is what was ticked, ranged or named, never a page left
  // behind out of sight. Swapped as the click lands, not in an effect: the
  // next click's own jump would reach the old watch first.
  const stopWatchRef = useRef<(() => void) | null>(null)

  const stopWatch = useCallback(() => {
    stopWatchRef.current?.()
    stopWatchRef.current = null
  }, [])

  const clear = useCallback(() => {
    stopWatch()
    setSelection(emptySelection)
  }, [stopWatch])

  const selectAll = useCallback(() => {
    stopWatch()
    setSelection(selectionOfAllPages(numPages))
  }, [numPages, stopWatch])

  const select = useCallback(
    (pageNumber: number, modifiers: SelectionModifiers) => {
      stopWatch()
      setSelection((current) =>
        selectionAfterClick(current, pageNumber, modifiers),
      )

      if (modifiers.range || modifiers.toggle) {
        return
      }

      stopWatchRef.current = currentPage.subscribe(() => {
        if (currentPage.get() !== pageNumber) {
          clear()
        }
      })
    },
    [clear, currentPage, stopWatch],
  )

  const selectGroup = useCallback(
    (pages: readonly number[], modifiers: SelectionModifiers) => {
      stopWatch()
      setSelection((current) => selectionAfterGroupClick(current, pages, modifiers))
    },
    [stopWatch],
  )

  const deselect = useCallback((pages: readonly number[]) => {
    setSelection((current) => selectionWithout(current, pages))
  }, [])

  useEffect(() => stopWatch, [stopWatch])

  useEffect(() => {
    if (!active) {
      clear()
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clear()
      }
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [active, clear])

  return { clear, deselect, select, selectAll, selectGroup, selectedPages: selection.pages }
}
