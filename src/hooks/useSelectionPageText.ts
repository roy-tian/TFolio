import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import type { RenderEpochs } from "@/lib/annotations"
import { copyPlainText } from "@/lib/clipboard"
import { pagePlainText } from "@/lib/documentText"
import { isAbortError } from "@/lib/pageWork"
import {
  registerPageTextReader,
  selectedPages,
  selectedPagesText,
} from "@/lib/selectionText"

type Options = {
  active: boolean
  documentId: number
  textEpochs: RenderEpochs
  viewerRef: RefObject<HTMLElement | null>
}

/**
 * Copies a selection of page text in PDFium's form, by key and by the page
 * menu: the pages between its ends come from PDFium, since only pages near
 * the reader keep spans. Read as the selection is made: the clipboard refuses
 * a write that comes long after the key asking for it.
 */
export function useSelectionPageText({ active, documentId, textEpochs, viewerRef }: Options) {
  // Read per call: an edit that moves a page's epoch must not restart reads.
  const epochs = useRef(textEpochs)
  const refollow = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    epochs.current = textEpochs
  })

  useEffect(() => {
    const viewer = viewerRef.current

    if (!active || !viewer) {
      return
    }

    // By page and text epoch: an edit leaves a page's earlier text behind.
    const texts = new Map<string, string | Promise<string>>()
    // One per read in flight: dropping a page must leave the others queued,
    // and the queue cannot take back a read PDFium already has.
    const reads = new Map<string, AbortController>()
    // Pages a copy is waiting on go ahead of the renders; counted, since a
    // second copy can wait on a page the first is still waiting on.
    const awaited = new Map<number, number>()
    let span: { first: number; last: number } | null = null
    let frame = 0
    let closed = false

    const keyOf = (pageNumber: number) => `${pageNumber}:${epochs.current[pageNumber] ?? 0}`

    const read = (pageNumber: number): string | Promise<string> => {
      const key = keyOf(pageNumber)
      const known = texts.get(key)

      if (known !== undefined) {
        return known
      }

      const controller = new AbortController()
      const settle = () => {
        if (reads.get(key) === controller) {
          reads.delete(key)
        }
      }
      const pending: Promise<string> = pagePlainText(documentId, pageNumber, {
        priority: () => (awaited.has(pageNumber) ? 0 : Number.MAX_SAFE_INTEGER),
        signal: controller.signal,
      }).then(
        (text) => {
          settle()

          // Dropped while PDFium had it: a page outside the selection stays out.
          if (texts.get(key) === pending) {
            texts.set(key, text)
          }

          return text
        },
        (error: unknown) => {
          settle()

          if (texts.get(key) === pending) {
            texts.delete(key)
          }

          // Dropped with the selection, or for an edit, after a copy took it.
          return isAbortError(error) && awaited.has(pageNumber) && !closed
            ? read(pageNumber)
            : ""
        },
      )

      texts.set(key, pending)
      reads.set(key, controller)

      return pending
    }

    const unregister = registerPageTextReader(viewer, (pageNumber, wait) => {
      // Spans stand in for a page still being read: nothing waits on it.
      if (!wait) {
        return read(pageNumber)
      }

      awaited.set(pageNumber, (awaited.get(pageNumber) ?? 0) + 1)
      const release = () => {
        const count = awaited.get(pageNumber) ?? 0

        if (count > 1) {
          awaited.set(pageNumber, count - 1)
        } else {
          awaited.delete(pageNumber)
        }
      }
      const text = read(pageNumber)

      if (typeof text === "string") {
        release()

        return text
      }

      return text.finally(release)
    })

    const follow = () => {
      frame = 0
      const selected = selectedPages(document.getSelection())
      const next =
        selected?.viewer === viewer && selected.last - selected.first > 1
          ? { first: selected.first, last: selected.last }
          : null

      if (next?.first === span?.first && next?.last === span?.last) {
        return
      }

      span = next

      for (const key of texts.keys()) {
        const pageNumber = Number.parseInt(key)

        // Out of the selection, or text an edit has since replaced.
        if (
          !next ||
          pageNumber <= next.first ||
          pageNumber >= next.last ||
          key !== keyOf(pageNumber)
        ) {
          texts.delete(key)
          reads.get(key)?.abort()
        }
      }

      if (!next) {
        return
      }

      for (let pageNumber = next.first + 1; pageNumber < next.last; pageNumber += 1) {
        void read(pageNumber)
      }
    }

    const handleSelectionChange = () => {
      if (!frame) {
        frame = requestAnimationFrame(follow)
      }
    }

    const handleCopy = (event: ClipboardEvent) => {
      const text = event.defaultPrevented
        ? null
        : selectedPagesText(document.getSelection(), viewer)

      // Nothing to write: the WebView's own copy is no worse than emptying
      // the clipboard.
      if (text === null || text === "") {
        return
      }

      // Taken even with every page's spans built: the WebView joins runs its
      // own way, not in PDFium's form.
      event.preventDefault()

      if (typeof text === "string" && event.clipboardData) {
        event.clipboardData.setData("text/plain", text)

        return
      }

      // A page still being read: the event's clipboard closes with this handler.
      void Promise.resolve(text).then(copyPlainText)
    }

    // An edit moves epochs under a standing selection with no selectionchange
    // to say so, and the pages between need reading again.
    refollow.current = () => {
      span = null
      handleSelectionChange()
    }

    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("copy", handleCopy)

    return () => {
      refollow.current = undefined
      closed = true
      cancelAnimationFrame(frame)

      for (const controller of reads.values()) {
        controller.abort()
      }

      unregister()
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("copy", handleCopy)
    }
  }, [active, documentId, viewerRef])

  // After the effect above, so it reaches the reads that effect now keeps.
  useEffect(() => {
    refollow.current?.()
  }, [textEpochs])
}
