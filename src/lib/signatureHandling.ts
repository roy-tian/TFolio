import { useSyncExternalStore } from "react"

import type { SignatureDecision } from "@/lib/pdf"
import { rememberSettings, storedSettings, subscribeSettings } from "@/lib/settings"

/** What a change that would break intact signatures does: ask the reader, or
    give the answer they told the app to remember. */
export type SignatureHandling = "ask" | SignatureDecision

export function isSignatureHandling(value: unknown): value is SignatureHandling {
  return value === "ask" || value === "flatten" || value === "keep"
}

/** Read at each use, so a choice made in another window applies here too. */
export function storedSignatureHandling(): SignatureHandling {
  const handling = storedSettings().signatures?.handling

  return isSignatureHandling(handling) ? handling : "ask"
}

export function storeSignatureHandling(handling: SignatureHandling) {
  void rememberSettings({ signatures: { handling } })
}

export function useSignatureHandling(): SignatureHandling {
  return useSyncExternalStore(subscribeSettings, storedSignatureHandling)
}
