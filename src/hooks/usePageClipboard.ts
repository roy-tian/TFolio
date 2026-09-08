import { useCallback, useEffect, useRef, useState } from "react"

import { isTypingTarget } from "@/lib/contextMenu"
import {
  clipboardAfterPaste,
  pageClipboardOf,
  type PageClipboard,
} from "@/lib/pageClipboard"

type UsePageClipboardOptions = {
  /** The grid is on screen and this document's: only there do these keys mean
      pages. The clipboard itself outlives that, so the reader can look at a
      page and come back to the grid to paste it. */
  active: boolean
  /** Runs a paste into the gap before this 1-based page — the owner's, since
      only it can say what the paste costs the document. */
  onPaste: (index: number) => void
  /** What a cut or a copy just took, for the notice the owner shows. */
  onTaken: (clipboard: PageClipboard) => void
  selectedPages: ReadonlySet<number>
}

/**
 * The thumbnail grid's own clipboard: the pages a cut or a copy took, and the
 * keys that take them. It holds page numbers, so every structure edit voids it
 * — the same honesty the grid's selection keeps — with one exception, the
 * paste's own insert, which says exactly how far the pages it names slid.
 *
 * The pages never leave the document they were taken from: the system
 * clipboard has nothing to say about PDF pages, and another document's grid
 * has the drag across the tab strip.
 */
export function usePageClipboard({
  active,
  onPaste,
  onTaken,
  selectedPages,
}: UsePageClipboardOptions) {
  const [clipboard, setClipboard] = useState<PageClipboard | null>(null)
  // The insert a paste is about to make: only that change may move the pages on
  // the clipboard, so it is consumed by the next one, and only if it fits.
  const pendingPasteRef = useRef<{
    count: number
    index: number
    numPages: number
  } | null>(null)

  // Latched rather than closed over: a keypress reads the selection of the
  // moment, and the listener below would otherwise be rebound on every click.
  const selectedPagesRef = useRef(selectedPages)

  selectedPagesRef.current = selectedPages

  const take = useCallback(
    (mode: PageClipboard["mode"]) => {
      const taken = pageClipboardOf(mode, selectedPagesRef.current)

      if (taken) {
        setClipboard(taken)
        onTaken(taken)
      }
    },
    [onTaken],
  )

  const armPaste = useCallback(
    (index: number, count: number, pageCount: number) => {
      pendingPasteRef.current = { count, index, numPages: pageCount + count }
    },
    [],
  )

  const disarmPaste = useCallback(() => {
    pendingPasteRef.current = null
  }, [])

  const copy = useCallback(() => take("copy"), [take])
  const cut = useCallback(() => take("cut"), [take])

  const structureChanged = useCallback((numPages: number) => {
    const pending = pendingPasteRef.current

    pendingPasteRef.current = null
    setClipboard((current) =>
      pending && pending.numPages === numPages
        ? clipboardAfterPaste(current, pending.index, pending.count)
        : null,
    )
  }, [])

  useEffect(() => {
    if (!active) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // A field being typed in keeps its own editing keys, and a dialog or
      // popup in front of the grid owns the keyboard while it stands.
      if (
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        document.querySelector(
          "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
        )
      ) {
        return
      }

      // As it clears the selection: a cut standing over the pages it marked is
      // the other thing Esc is for here.
      if (event.key === "Escape") {
        setClipboard(null)

        return
      }

      const key = event.key.toLowerCase()

      if (
        event.altKey ||
        event.shiftKey ||
        (!event.ctrlKey && !event.metaKey) ||
        (key !== "c" && key !== "v" && key !== "x")
      ) {
        return
      }

      // Consumed whether or not there is anything to do with it: in the grid
      // these keys are about pages, and there is nothing else here to cut.
      event.preventDefault()

      if (event.repeat) {
        return
      }

      if (key === "v") {
        // Where the reader is looking, as the + between two pages is: the paste
        // goes in front of the first page they have chosen. Folded rather than
        // spread — a select-all hands this every page in the document.
        let first: number | null = null

        for (const pageNumber of selectedPagesRef.current) {
          if (first === null || pageNumber < first) {
            first = pageNumber
          }
        }

        if (first !== null) {
          onPaste(first)
        }

        return
      }

      take(key === "x" ? "cut" : "copy")
    }

    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [active, onPaste, take])

  return { armPaste, clipboard, copy, cut, disarmPaste, structureChanged }
}
