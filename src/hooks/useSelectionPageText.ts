import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import type { RenderEpochs } from "@/lib/annotations"
import { copyPlainText } from "@/lib/clipboard"
import { pagePlainText } from "@/lib/documentText"
import { isAbortError } from "@/lib/pageWork"
import {
  pagesBetween,
  registerPageTextReader,
  selectedPages,
  selectedPagesText,
} from "@/lib/selectionText"
import { textPage } from "@/lib/textSelectionPage"

type Options = {
  active: boolean
  documentId: number
  textEpochs: RenderEpochs
  viewerRef: RefObject<HTMLElement | null>
}

/**
 * Gives a selection over pages without spans — only pages near the reader
 * keep theirs — PDFium's text for them, in the WebView's copy and the page
 * menu's. Read as the selection is made: the clipboard refuses a write that
 * comes long after the key asking for it.
 */
export function useSelectionPageText({ active, documentId, textEpochs, viewerRef }: Options) {
  // Read per call: an edit that moves a page's epoch must not restart reads.
  const epochs = useRef(textEpochs)
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
    // Pages a copy is waiting on go ahead of the renders.
    const awaited = new Set<string>()
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
        priority: () => (awaited.has(key) ? 0 : Number.MAX_SAFE_INTEGER),
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

          // Dropped with the selection that asked, after a copy took it.
          return isAbortError(error) && awaited.has(key) && !closed ? read(pageNumber) : ""
        },
      )

      texts.set(key, pending)
      reads.set(key, controller)

      return pending
    }

    const unregister = registerPageTextReader(viewer, (pageNumber) => {
      const key = keyOf(pageNumber)
      awaited.add(key)
      const text = read(pageNumber)

      if (typeof text === "string") {
        awaited.delete(key)

        return text
      }

      return text.finally(() => awaited.delete(key))
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

        if (!next || pageNumber <= next.first || pageNumber >= next.last) {
          texts.delete(key)
          reads.get(key)?.abort()
        }
      }

      if (!next) {
        return
      }

      for (const [pageNumber, page] of pagesBetween(selected!)) {
        if (!textPage(page)) {
          void read(pageNumber)
        }
      }
    }

    const handleSelectionChange = () => {
      if (!frame) {
        frame = requestAnimationFrame(follow)
      }
    }

    const handleCopy = (event: ClipboardEvent) => {
      const selected = event.defaultPrevented
        ? null
        : selectedPagesText(document.getSelection(), viewer)

      // Every page in it has its spans: the WebView's own copy is whole.
      if (!selected || selected.complete) {
        return
      }

      event.preventDefault()

      if (typeof selected.text === "string" && event.clipboardData) {
        event.clipboardData.setData("text/plain", selected.text)

        return
      }

      // A page still being read: the event's clipboard closes with this handler.
      void Promise.resolve(selected.text).then(copyPlainText)
    }

    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("copy", handleCopy)

    return () => {
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
}
