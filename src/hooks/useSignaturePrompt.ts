import { useCallback, useRef, useState } from "react"

import type { SignatureDecision } from "@/lib/pdf"
import { storeSignatureHandling } from "@/lib/signatureHandling"

/** Where the change comes from: the document itself, a new file of its pages,
    or an organize assembly taking pages from signed files. */
export type SignaturePromptContext = "edit" | "export" | "insert" | "organize"

export type SignaturePromptRequest = {
  context: SignaturePromptContext
  /** Signatures in the document, or signed files in the assembly or among
      the files added. */
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
  // Unticked at each ask: remembering is the reader's choice every time.
  const [remember, setRemember] = useState(false)
  const rememberRef = useRef(false)
  const resolveRef = useRef<((answer: SignatureDecision | null) => void) | null>(null)

  const ask = useCallback<AskSignatures>((next) => {
    if (resolveRef.current) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      resolveRef.current = resolve
      rememberRef.current = false
      setRemember(false)
      setRequest(next)
      setOpen(true)
    })
  }, [])

  const changeRemember = useCallback((next: boolean) => {
    rememberRef.current = next
    setRemember(next)
  }, [])

  // A cancel is never remembered: it answers this change, not every one.
  const answer = useCallback((value: SignatureDecision | null) => {
    const resolve = resolveRef.current

    if (value && rememberRef.current) {
      storeSignatureHandling(value)
    }

    resolveRef.current = null
    setOpen(false)
    resolve?.(value)
  }, [])

  return { answer, ask, changeRemember, open, remember, request }
}
