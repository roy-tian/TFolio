import { useCallback, useRef, useState } from "react"

import type { AskBatchLimit, BatchLimit } from "@/lib/batchLimits"

/** The window's one prompt over files past a go's limit. An ask while it is
    open answers no at once: the dialog is modal, so the second asker is acting
    behind it. */
export function useBatchLimitPrompt() {
  // Kept after an answer, so the prompt keeps its words while it fades out.
  const [limit, setLimit] = useState<BatchLimit | null>(null)
  const [open, setOpen] = useState(false)
  const resolveRef = useRef<((take: boolean) => void) | null>(null)

  const ask = useCallback<AskBatchLimit>((next) => {
    if (resolveRef.current) {
      return Promise.resolve(false)
    }

    return new Promise((resolve) => {
      resolveRef.current = resolve
      setLimit(next)
      setOpen(true)
    })
  }, [])

  const answer = useCallback((take: boolean) => {
    const resolve = resolveRef.current

    resolveRef.current = null
    setOpen(false)
    resolve?.(take)
  }, [])

  return { answer, ask, limit, open }
}
