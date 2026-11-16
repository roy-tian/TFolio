import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"

import { hasLayerOverWorkspace, isTypingTarget } from "@/lib/contextMenu"
import {
  clipboardAfterPaste,
  heldPages,
  holdPages,
  letGoOfPages,
  pageClipboardOf,
  registerPageSource,
  subscribeHeldPages,
  type PageClipboard,
} from "@/lib/pageClipboard"

type UsePageClipboardOptions = {
  /** True only while the sidebar's previews have focus; the clipboard itself
      outlives that, so a paste can still happen once the reader comes back. */
  active: boolean
  documentId: number
  /** The document's name, for another to say it is busy by. */
  documentName: string
  /** The page a paste lands after with none chosen: the one being read, or
      null where it shows no paper to land by. */
  pasteAfterPage: () => number | null
  /** Whether the pages still stand as the clipboard numbers them, with no
      structure edit in flight: asked as another document reads them by number. */
  isIdle: () => boolean
  /** Esc took a cut back: what the cut said is no longer so. */
  onCutCancelled: () => void
  /** A cut made here is being pasted into another document: its pages leave
      this one once `copied` says the copies landed, which only its owner can
      do — queued now, ahead of any edit made here meanwhile. False where they
      stay. */
  onMovedAway: (pages: number[], copied: Promise<boolean>) => boolean
  /** Runs a paste after this 1-based page — the owner's, since only it can
      say what the paste costs the document. */
  onPaste: (after: number) => void
  onTaken: (clipboard: PageClipboard) => void
  selectedPages: ReadonlySet<number>
  /** While the previews show, Esc takes back a cut: its faded pages are on
      screen whether or not the column has focus. */
  shown: boolean
  /** The tab is the one on show. Only it follows what other documents hold,
      so a cut or copy re-renders no tab behind the one it was made in. */
  tabShown: boolean
}

/**
 * Page numbers, voided by every structure edit except the paste's own insert,
 * and never sent to the system clipboard, which cannot carry PDF pages. The
 * clipboard is the window's one (`lib/pageClipboard`): this is a document's
 * half of it, the pages it holds itself and those another holds for it to
 * paste, with no copy of either kept here to fall out of step.
 */
export function usePageClipboard({
  active,
  documentId,
  documentName,
  isIdle,
  onCutCancelled,
  onMovedAway,
  onPaste,
  onTaken,
  pasteAfterPage,
  selectedPages,
  shown,
  tabShown,
}: UsePageClipboardOptions) {
  const followed = useSyncExternalStore(subscribeHeldPages, () => {
    const held = heldPages()

    return held && (tabShown || held.sourceDocumentId === documentId) ? held : null
  })
  const clipboard = followed?.sourceDocumentId === documentId ? followed : null
  // Pages another of the window's documents holds, which a paste here copies in.
  const foreign = followed && followed.sourceDocumentId !== documentId ? followed : null
  // Read when the keys or another document ask, which is after any render.
  const latestRef = useRef({ documentName, isIdle, onCutCancelled, onMovedAway, pasteAfterPage })

  latestRef.current = { documentName, isIdle, onCutCancelled, onMovedAway, pasteAfterPage }
  // Counted as they land, before any render: another document reading these
  // pages by number asks whether one has landed since it took them.
  const editsRef = useRef(0)

  // What this document answers for the pages it holds; a tab closed with
  // pages on the clipboard takes them with it.
  useEffect(
    () =>
      registerPageSource(documentId, {
        edits: () => editsRef.current,
        idle: () => latestRef.current.isIdle(),
        name: () => latestRef.current.documentName,
        // A cut still standing here would fade pages no paste will ever move.
        superseded: (held) => {
          if (held.mode === "cut") {
            latestRef.current.onCutCancelled()
          }
        },
        takeOut: (pages, copied) => latestRef.current.onMovedAway(pages, copied),
      }),
    [documentId],
  )

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

  // The pages named, else the chosen ones: what the bar over the pages acts
  // on, so the keys take the same, and none with none chosen.
  const take = useCallback(
    (mode: PageClipboard["mode"], pages?: Iterable<number>) => {
      const taken = pageClipboardOf(mode, pages ?? selectedPagesRef.current)

      if (taken) {
        holdPages({ ...taken, sourceDocumentId: documentId })
        onTaken(taken)
      }
    },
    [documentId, onTaken],
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
      which a choice lapsing under it must not empty. */
  const copyPages = useCallback((pages: Iterable<number>) => take("copy", pages), [take])
  const cutPages = useCallback((pages: Iterable<number>) => take("cut", pages), [take])

  const structureChanged = useCallback(
    (numPages: number) => {
      const pending = pendingPasteRef.current
      const held = heldPages()

      pendingPasteRef.current = null
      editsRef.current += 1

      if (held?.sourceDocumentId !== documentId) {
        return
      }

      // In the store at once, not at a render that follows: a paste landing
      // in another document meanwhile would act on numbers that name other pages.
      const kept =
        pending && pending.numPages === numPages
          ? clipboardAfterPaste(held, pending.index, pending.count)
          : null

      if (kept) {
        holdPages({ ...kept, sourceDocumentId: documentId })
      } else {
        letGoOfPages(documentId)
      }
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

        last ??= latestRef.current.pasteAfterPage()

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
      const held = heldPages()

      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !isTypingTarget(event.target) &&
        !hasLayerOverWorkspace() &&
        held?.sourceDocumentId === documentId &&
        held.mode === "cut"
      ) {
        letGoOfPages(documentId)
        onCutCancelled()
      }
    }

    document.addEventListener("keydown", cancelCut)

    return () => document.removeEventListener("keydown", cancelCut)
  }, [documentId, onCutCancelled, shown])

  return {
    armPaste,
    clipboard,
    copyPages,
    cutPages,
    disarmPaste,
    foreign,
    structureChanged,
  }
}
