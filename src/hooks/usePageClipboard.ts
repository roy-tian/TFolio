import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import { hasLayerOverWorkspace, isTypingTarget } from "@/lib/contextMenu"
import {
  clipboardAfterPaste,
  pageClipboardOf,
  sharePages,
  sharedPages,
  subscribeSharedPages,
  unsharePages,
  type PageClipboard,
  type SharedPages,
} from "@/lib/pageClipboard"

type UsePageClipboardOptions = {
  /** True only while the sidebar's previews have focus; the clipboard itself
      outlives that, so a paste can still happen once the reader comes back. */
  active: boolean
  documentId: number
  /** The page the keys take with none chosen: the one being read, or null
      where it shows no paper to be taken by. */
  fallbackPage: () => number | null
  /** Esc took a cut back: what the cut said is no longer so. */
  onCutCancelled: () => void
  /** A cut made here was pasted into another document: its pages leave this
      one, which only its owner can do. */
  onMovedAway: (pages: number[]) => void
  /** Runs a paste after this 1-based page — the owner's, since only it can
      say what the paste costs the document. */
  onPaste: (after: number) => void
  onTaken: (clipboard: PageClipboard) => void
  selectedPages: ReadonlySet<number>
  /** While the previews show, Esc takes back a cut: its faded pages are on
      screen whether or not the column has focus. */
  shown: boolean
}

/**
 * Page numbers, voided by every structure edit except the paste's own insert,
 * and never sent to the system clipboard, which cannot carry PDF pages. The
 * window's other documents can paste them: what one takes is shared while it
 * holds it, and replaces what any other held, as one clipboard would.
 */
export function usePageClipboard({
  active,
  documentId,
  fallbackPage,
  onCutCancelled,
  onMovedAway,
  onPaste,
  onTaken,
  selectedPages,
  shown,
}: UsePageClipboardOptions) {
  const [clipboard, setClipboard] = useState<PageClipboard | null>(null)
  const clipboardRef = useRef(clipboard)

  clipboardRef.current = clipboard

  const shared = useSyncExternalStore(subscribeSharedPages, sharedPages)
  // Pages another of the window's documents holds, which a paste here copies in.
  const foreign = shared && shared.sourceDocumentId !== documentId ? shared : null
  // Read when the keys or another document ask, which is after any render.
  const latestRef = useRef({ fallbackPage, onMovedAway })

  latestRef.current = { fallbackPage, onMovedAway }

  useEffect(() => {
    if (!clipboard) {
      unsharePages(documentId)
      return
    }

    const { pages } = clipboard
    const entry: SharedPages = {
      ...clipboard,
      // Once, and only while these are still what the window holds: a second
      // paste, or one landing after an edit here withdrew them, would take
      // out whatever pages then hold their numbers.
      onMoved: () => {
        if (sharedPages() === entry) {
          unsharePages(documentId)
          latestRef.current.onMovedAway(pages)
        }
      },
      sourceDocumentId: documentId,
    }

    sharePages(entry)
  }, [clipboard, documentId])

  // A tab closed with pages on the clipboard takes them with it.
  useEffect(() => () => unsharePages(documentId), [documentId])

  // Another document's cut or copy is the clipboard now: a cut still standing
  // here would fade pages no paste will ever move.
  useEffect(() => {
    if (foreign && clipboardRef.current) {
      const wasCut = clipboardRef.current.mode === "cut"

      setClipboard(null)

      if (wasCut) {
        onCutCancelled()
      }
    }
  }, [foreign, onCutCancelled])
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

  // The pages named, else the chosen ones, else the page being read: what
  // the bar over the pages acts on, so the keys take the same.
  const take = useCallback(
    (mode: PageClipboard["mode"], pages?: Iterable<number>) => {
      const chosen = selectedPagesRef.current
      const fallback = pages || chosen.size > 0 ? null : latestRef.current.fallbackPage()
      const taken = pageClipboardOf(mode, pages ?? (fallback === null ? chosen : [fallback]))

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

  /** Pages by number, whatever is chosen: the ones a menu was opened on,
      which a choice lapsing under it must not swap for the page being read. */
  const copyPages = useCallback((pages: Iterable<number>) => take("copy", pages), [take])
  const cutPages = useCallback((pages: Iterable<number>) => take("cut", pages), [take])
  /** Lets go of what is held, moving nothing: a cut another document took
      that could not then leave this one. */
  const release = useCallback(() => setClipboard(null), [])

  const structureChanged = useCallback(
    (numPages: number) => {
      const pending = pendingPasteRef.current
      const ownPaste = pending !== null && pending.numPages === numPages

      pendingPasteRef.current = null

      // Withdrawn now, not at the render that follows: a paste landing in
      // another document meanwhile would act on numbers that name other pages.
      if (!ownPaste) {
        unsharePages(documentId)
      }

      setClipboard((current) =>
        ownPaste ? clipboardAfterPaste(current, pending.index, pending.count) : null,
      )
    },
    [documentId],
  )

  useEffect(() => {
    if (!active) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // A field being typed in keeps its own editing keys, and a dialog or
      // popup in front of the previews owns the keyboard while it stands.
      if (
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        hasLayerOverWorkspace()
      ) {
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

      // Consumed whether or not there is anything to do with it: with the
      // previews focused these keys are about pages, and nothing else is cut.
      event.preventDefault()

      if (event.repeat) {
        return
      }

      if (key === "v") {
        // The paste lands after the last chosen page, as a paste does in
        // most places, or with none chosen after the page being read —
        // folded, not spread, so a select-all still pastes at the end.
        let last: number | null = null

        for (const pageNumber of selectedPagesRef.current) {
          if (last === null || pageNumber > last) {
            last = pageNumber
          }
        }

        last ??= latestRef.current.fallbackPage()

        if (last !== null) {
          onPaste(last)
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

  useEffect(() => {
    if (!shown) {
      return
    }

    // As it clears the selection. A copy stays: it shows nothing to take back.
    const cancelCut = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !isTypingTarget(event.target) &&
        !hasLayerOverWorkspace() &&
        clipboardRef.current?.mode === "cut"
      ) {
        setClipboard(null)
        onCutCancelled()
      }
    }

    document.addEventListener("keydown", cancelCut)

    return () => document.removeEventListener("keydown", cancelCut)
  }, [onCutCancelled, shown])

  return {
    armPaste,
    clipboard,
    copyPages,
    cutPages,
    disarmPaste,
    foreign,
    release,
    structureChanged,
  }
}
