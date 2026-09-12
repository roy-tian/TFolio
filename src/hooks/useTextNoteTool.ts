import { useCallback, useEffect, useRef, useState } from "react"
import type { RefObject } from "react"

import { useReleasedPreviews } from "@/hooks/useReleasedPreviews"
import {
  clampFraction,
  clientPointToFraction,
  fractionToPagePoint,
  type PagePoint,
} from "@/lib/annotationGeometry"
import type {
  RenderEpochs,
  TextNoteCommand,
  TextNoteStyle,
} from "@/lib/annotations"
import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import type { PdfPageInfo } from "@/lib/pdf"
import {
  clampNoteText,
  noteDraftToCommand,
  startNoteDraft,
  type TextNoteDraft,
} from "@/lib/textNoteDraft"

type UseTextNoteToolOptions = {
  active: boolean
  onCommit: (
    command: TextNoteCommand,
    onApplied: (epochs: RenderEpochs) => void,
  ) => Promise<boolean>
  /** Temporarily detach document listeners without settling the draft or tool. */
  suspended?: boolean
  pages: PdfPageInfo[]
  rotations: PageRotations
  style: TextNoteStyle
  viewerRef: RefObject<HTMLElement | null>
}

export type TextNotePreview = {
  id: number
  origin: PagePoint
  pageNumber: number
  style: TextNoteStyle
  text: string
  /** Present only once the backend has accepted this note. */
  renderEpoch?: number
}

export type TextNoteTool = {
  /** Attach to the editor, so a click inside it is not treated as one outside. */
  editorRef: RefObject<HTMLElement | null>
  cancel: () => void
  commit: () => void
  draft: TextNoteDraft | null
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  previews: TextNotePreview[]
  setText: (text: string) => void
}

/**
 * Nothing crosses IPC until close, so a note is one command and one undo; and
 * closing commits rather than discards — only an empty note is dropped.
 */
export function useTextNoteTool({
  active,
  onCommit,
  pages,
  suspended = false,
  rotations,
  style,
  viewerRef,
}: UseTextNoteToolOptions): TextNoteTool {
  const [draft, setDraft] = useState<TextNoteDraft | null>(null)
  const { onPagePaint, previews, release, takeId } =
    useReleasedPreviews<TextNotePreview>()
  const editorRef = useRef<HTMLElement | null>(null)
  // Listeners bind once per activation but read the draft and style as they
  // are now; written in an effect, since a discarded render must not set them.
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
    if (!command) {
      return
    }

    // Closing the editor and holding the note are one update, so the text is
    // never off the page for a frame while PDFium and a decode catch up.
    release(
      {
        id: takeId(),
        origin: command.origin,
        pageNumber: command.pageNumber,
        style: command.style,
        text: command.text,
      },
      (onApplied) => onCommit(command, onApplied),
    )
  }, [onCommit, release, takeId])

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

      // A right-click or second finger would otherwise close the open note and
      // open another, swallowing the gesture it was meant for.
      if (event.button !== 0 || !event.isPrimary) {
        return
      }

      // Inside the editor — a swipe over the text, a press on its toolbar — is
      // the reader working on the note, not leaving it.
      if (editorRef.current?.contains(target)) {
        return
      }

      const viewer = viewerRef.current

      // App furniture is not finishing the note: closing there would drop an
      // empty one mid-placement or commit a half-typed one, so it is left open.
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
        rotationForPage(rotations, pageNumber),
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
  }, [active, cancel, commit, pages, rotations, suspended, viewerRef])

  return { cancel, commit, draft, editorRef, onPagePaint, previews, setText }
}
