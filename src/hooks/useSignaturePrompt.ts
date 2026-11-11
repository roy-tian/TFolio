import { useCallback, useRef, useState } from "react"

import type { SignatureDecision } from "@/lib/pdf"
import { storeSignatureHandling } from "@/lib/signatureHandling"

/** Where the change comes from: the document itself, a new file of its pages,
    or signed files added to the document. */
export type SignaturePromptContext = "edit" | "export" | "insert"

export type SignaturePromptRequest = {
  context: SignaturePromptContext
  /** Signatures in the document; unused for an added file. */
  count: number
  /** The document's file name, or the added file's: each is asked about alone. */
  name: string
  /** Signed files added with this one and still to be asked about, which the
      reader may give this answer too. */
  rest?: number
}

export type SignatureAnswer = {
  decision: SignatureDecision
  /** Given for the request's `rest` as well. */
  forRest: boolean
}

export type AskSignatures = (request: SignaturePromptRequest) => Promise<SignatureAnswer | null>

/** The window's one signature prompt. An ask while it is open answers null at
    once: the dialog is modal, so the second asker is acting behind it. */
export function useSignaturePrompt() {
  // Kept after an answer, so the prompt keeps its words while it fades out.
  const [request, setRequest] = useState<SignaturePromptRequest | null>(null)
  const [open, setOpen] = useState(false)
  // Unticked at each ask: remembering is the reader's choice every time.
  const [remember, setRemember] = useState(false)
  const rememberRef = useRef(false)
  // Unticked at each ask too: the next file may want another answer.
  const [forRest, setForRest] = useState(false)
  const forRestRef = useRef(false)
  const resolveRef = useRef<((answer: SignatureAnswer | null) => void) | null>(null)

  const ask = useCallback<AskSignatures>((next) => {
    if (resolveRef.current) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      resolveRef.current = resolve
      rememberRef.current = false
      setRemember(false)
      forRestRef.current = false
      setForRest(false)
      setRequest(next)
      setOpen(true)
    })
  }, [])

  const changeRemember = useCallback((next: boolean) => {
    rememberRef.current = next
    setRemember(next)
  }, [])

  const changeForRest = useCallback((next: boolean) => {
    forRestRef.current = next
    setForRest(next)
  }, [])

  // A cancel is never remembered: it answers this change, not every one.
  const answer = useCallback((value: SignatureDecision | null) => {
    const resolve = resolveRef.current

    if (value && rememberRef.current) {
      storeSignatureHandling(value)
    }

    resolveRef.current = null
    setOpen(false)
    resolve?.(value ? { decision: value, forRest: forRestRef.current } : null)
  }, [])

  return { answer, ask, changeForRest, changeRemember, forRest, open, remember, request }
}
