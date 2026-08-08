import { useCallback, useEffect, useRef, useState } from "react"
import type { RefObject } from "react"

import {
  clampFraction,
  clientPointToFraction,
  fractionToPagePoint,
} from "@/lib/annotationGeometry"
import type { TextNoteCommand, TextNoteStyle } from "@/lib/annotations"
import type { PdfPageInfo } from "@/lib/pdf"
import {
  clampNoteText,
  noteDraftToCommand,
  startNoteDraft,
  type TextNoteDraft,
} from "@/lib/textNoteDraft"

type UseTextNoteToolOptions = {
  active: boolean
  onCommit: (command: TextNoteCommand) => void
  /** Temporarily detach document listeners without settling the draft or tool. */
  suspended?: boolean
  pages: PdfPageInfo[]
  rotation: number
  style: TextNoteStyle
  viewerRef: RefObject<HTMLElement | null>
}

export type TextNoteTool = {
  /** Attach to the editor, so a click inside it is not treated as one outside. */
  editorRef: RefObject<HTMLElement | null>
  cancel: () => void
  commit: () => void
  draft: TextNoteDraft | null
  setText: (text: string) => void
}

/**
 * A note is placed with a click, typed into, and written only once the reader is
 * finished with it — so nothing crosses the IPC boundary until then, and a note
 * is one command and one undo however long it took to type.
 *
 * Closing is a commit, not a discard: a reader who clicks away from an editor
 * they have typed into means to keep what they wrote. Only an empty one is
 * dropped, which is what makes a stray click harmless rather than an error.
 */
export function useTextNoteTool({
  active,
  onCommit,
  pages,
  suspended = false,
  rotation,
  style,
  viewerRef,
}: UseTextNoteToolOptions): TextNoteTool {
  const [draft, setDraft] = useState<TextNoteDraft | null>(null)
  const editorRef = useRef<HTMLElement | null>(null)
  // The listeners below are bound once per activation but must always act on the
  // draft and style as they are now, not as they were when the effect last ran.
  //
  // Written after the render rather than during it: a render React discards
  // still runs the component body, and a ref set there would keep a value that
  // was never shown. Effects only run for renders that commit, and they flush
  // before the next event a listener could fire on.
  const draftRef = useRef<TextNoteDraft | null>(null)
  const styleRef = useRef(style)

  useEffect(() => {
    draftRef.current = draft
    styleRef.current = style
  })

  const cancel = useCallback(() => {
    draftRef.current = null
    setDraft(null)
  }, [])

  const commit = useCallback(() => {
    const current = draftRef.current

    draftRef.current = null
    setDraft(null)

    if (!current) {
      return
    }

    const command = noteDraftToCommand(current, styleRef.current)

    // An editor closed without a word in it is not an edit. Dropped in silence:
    // the reader has not lost anything, and the backend would refuse it anyway.
    if (command) {
      onCommit(command)
    }
  }, [onCommit])

  const setText = useCallback((text: string) => {
    setDraft((current) =>
      current ? { ...current, text: clampNoteText(text) } : current,
    )
  }, [])

  useEffect(() => {
    if (suspended) {
      return
    }

    if (!active) {
      // Putting the tool away keeps what was typed rather than dropping it, the
      // same as clicking away from the editor does.
      if (draftRef.current) {
        commit()
      }

      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target

      if (!(target instanceof Element)) {
        return
      }

      // Only the primary button of the primary pointer places a note, as with a
      // rectangle: a right-click or a second finger would otherwise close the
      // open note and open another, and swallow the gesture it was meant for.
      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      // Inside the editor — a swipe over the text, a press on its toolbar — is
      // the reader working on the note, not leaving it.
      if (editorRef.current?.contains(target)) {
        return
      }

      const viewer = viewerRef.current

      // Off the viewer entirely is the app's own furniture — zoom, rotate,
      // bookmarks, settings — and reaching for one of those is not finishing
      // the note. Closing on it would throw away an empty note the moment the
      // reader zoomed in to place it accurately, and commit a half-typed one.
      // The note is left alone; it is finished from its own buttons, with
      // Escape or Cmd/Ctrl+Enter, or by clicking the document again.
      if (!viewer || !viewer.contains(target)) {
        return
      }

      const pageElement = target.closest("[data-page-number]")

      if (!pageElement) {
        commit()
        return
      }

      const pageNumber = Number(pageElement.getAttribute("data-page-number"))
      const page = pages[pageNumber - 1]

      if (!page) {
        commit()
        return
      }

      // Suppress the text selection a press on the text layer would begin; the
      // click is placing a note, not starting a drag.
      event.preventDefault()

      const origin = fractionToPagePoint(
        clampFraction(
          clientPointToFraction(
            pageElement.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          ),
        ),
        page,
        rotation,
      )

      // The open note is written before the new one opens, so two editors are
      // never on the page at once and their order is the order they were typed.
      commit()
      setDraft(startNoteDraft(pageNumber, origin))
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!draftRef.current) {
        return
      }

      if (event.key === "Escape") {
        event.preventDefault()
        cancel()
        return
      }

      // The usual "I am done with this box" chord, since Enter itself is a line
      // break in a note.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        commit()
      }
    }

    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [active, cancel, commit, pages, rotation, suspended, viewerRef])

  return { cancel, commit, draft, editorRef, setText }
}
