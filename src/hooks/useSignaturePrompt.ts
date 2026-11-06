import { useCallback, useRef, useState } from "react"

import type { SignatureDecision } from "@/lib/pdf"

/** Where the change comes from: the document itself, a new file of its pages,
    or an organize assembly taking pages from signed files. */
export type SignaturePromptContext = "edit" | "export" | "organize"

export type SignaturePromptRequest = {
  context: SignaturePromptContext
  /** Signatures in the document, or signed files in the assembly. */
  count: number
  /** The document's file name; unused for an assembly. */
  name: string
}

export type AskSignatures = (
  request: SignaturePromptRequest,
) => Promise<SignatureDecision | null>

/** The window's one signature prompt. An ask while it is open answers null at
    once: the dialog is modal, so the second asker is acting behind it. */
export function useSignaturePrompt() {
  // Kept after an answer, so the prompt keeps its words while it fades out.
  const [request, setRequest] = useState<SignaturePromptRequest | null>(null)
  const [open, setOpen] = useState(false)
  const resolveRef = useRef<((answer: SignatureDecision | null) => void) | null>(null)

  const ask = useCallback<AskSignatures>((next) => {
    if (resolveRef.current) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      resolveRef.current = resolve
      setRequest(next)
      setOpen(true)
    })
  }, [])

  const answer = useCallback((value: SignatureDecision | null) => {
    const resolve = resolveRef.current

    resolveRef.current = null
    setOpen(false)
    resolve?.(value)
  }, [])

  return { answer, ask, open, request }
}
