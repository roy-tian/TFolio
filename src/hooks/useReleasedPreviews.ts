import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"

import type { RenderEpochs } from "@/lib/annotations"

export type ReleasedPreview = {
  id: number
  pageNumber: number
  /** Present only once the backend has accepted this preview's command. */
  renderEpoch?: number
}

/**
 * A command's pixels are a round trip and a decode away, so the preview stays
 * until the page's own paint — not a timer or the promise — retires it.
 */
export function useReleasedPreviews<Preview extends ReleasedPreview>() {
  const [previews, setPreviews] = useState<Preview[]>([])
  const previewsRef = useRef(previews)
  const nextId = useRef(0)

  useLayoutEffect(() => {
    previewsRef.current = previews
  }, [previews])

  const onPagePaint = useCallback((pageNumber: number, renderEpoch: number) => {
    const covered = (item: Preview) =>
      item.pageNumber === pageNumber &&
      item.renderEpoch !== undefined &&
      item.renderEpoch <= renderEpoch

    if (!previewsRef.current.some(covered)) {
      return
    }

    // The canvas is replaced in this same task. Retire its previews before the
    // browser can show the new pixels underneath them (double ink or opacity).
    flushSync(() => {
      setPreviews((current) => current.filter((item) => !covered(item)))
    })
  }, [])

  /**
   * Holds `preview` until `commit`'s own render lands. A command that never
   * happened — refused, superseded, or failed — takes its preview back off.
   */
  const release = useCallback(
    (
      preview: Preview,
      commit: (onApplied: (epochs: RenderEpochs) => void) => Promise<boolean>,
    ) => {
      setPreviews((items) => [...items, preview])

      const discard = () =>
        setPreviews((items) => items.filter((item) => item.id !== preview.id))

      void commit((epochs) => {
        setPreviews((items) =>
          items.map((item) =>
            item.id === preview.id
              ? { ...item, renderEpoch: epochs[preview.pageNumber] }
              : item,
          ),
        )
      })
        .then((applied) => {
          if (!applied) {
            discard()
          }
        })
        .catch(discard)
    },
    [],
  )

  /** A preview's identity, taken before the gesture that will release it ends,
      so the live preview and the held one are one element rather than two. */
  const takeId = useCallback(() => {
    nextId.current += 1

    return nextId.current
  }, [])

  return { onPagePaint, previews, release, takeId }
}
