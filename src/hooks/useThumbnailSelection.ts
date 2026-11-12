import { useCallback, useEffect, useRef, useState } from "react"

import type { CurrentPage } from "@/hooks/useCurrentPage"
import {
  emptySelection,
  plainChoiceWatch,
  selectionAfterClick,
  selectionAfterGroupClick,
  selectionOfAllPages,
  selectionWithout,
  type SelectionModifiers,
  type ThumbnailSelection,
} from "@/lib/thumbnailSelection"

// How long the page being read stays put before a plain click's jump counts
// as landed short of its page, or a move the app made as over.
const JUMP_SETTLE_MS = 300

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
  // A plain click goes to its page and chooses it only while it is read: what
  // stays chosen as the reader reads on is what was ticked, ranged or named,
  // never a page left behind out of sight. Swapped as the click lands, not in
  // an effect: the next click's own jump would reach the old watch first.
  const watchRef = useRef<{ resettle: () => void; stop: () => void } | null>(null)

  const stopWatch = useCallback(() => {
    watchRef.current?.stop()
    watchRef.current = null
  }, [])

  /** A move of the page being read that the app made itself, as a turn
      clamping the scroll: the choice lands again where it leaves the reader. */
  const resettle = useCallback(() => {
    watchRef.current?.resettle()
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

      const watch = plainChoiceWatch(pageNumber)
      let timer = 0
      const settleLater = () => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => watch.settle(currentPage.get()), JUMP_SETTLE_MS)
      }

      settleLater()

      const unsubscribe = currentPage.subscribe(() => {
        if (watch.heard(currentPage.get())) {
          clear()
        } else if (!watch.landed) {
          settleLater()
        }
      })

      watchRef.current = {
        resettle: () => {
          watch.unsettle()
          settleLater()
        },
        stop: () => {
          window.clearTimeout(timer)
          unsubscribe()
        },
      }
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

  return {
    clear,
    deselect,
    resettle,
    select,
    selectAll,
    selectGroup,
    selectedPages: selection.pages,
  }
}
