import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  draftFromConfig,
  draftFromPreferences,
  defaultPageNumbersPreferences,
  loadPageNumbersPreferences,
  parsePageNumbersDraft,
  storePageNumbersPreferences,
  type PageNumbersConfig,
  type PageNumbersDraft,
} from "@/lib/pageNumbers"

type UsePageNumbersOptions = {
  activeConfig: PageNumbersConfig | null
  documentId?: number
  /** Resolves to whether the change reached the document. */
  onSet: (config: PageNumbersConfig | null, pageCount: number) => Promise<boolean>
  pageCount: number
}

/** Owns the dialog's disposable draft; only apply and remove touch the PDF. */
export function usePageNumbers({
  activeConfig,
  documentId,
  onSet,
  pageCount,
}: UsePageNumbersOptions) {
  const [draft, setDraft] = useState<PageNumbersDraft>(() =>
    activeConfig
      ? draftFromConfig(activeConfig, pageCount)
      : draftFromPreferences(defaultPageNumbersPreferences, pageCount),
  )
  const [isApplying, setIsApplying] = useState(false)
  const [open, setOpen] = useState(false)
  // Whether the reader has changed anything since the dialog opened, so the
  // stored style — which arrives an IPC round trip later — is only ever laid
  // over a draft nobody has touched.
  const untouched = useRef(false)

  const changeDraft = useCallback((next: PageNumbersDraft) => {
    untouched.current = false
    setDraft(next)
  }, [])

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)

      if (!nextOpen) {
        return
      }

      // The document's own numbers, where it has them; otherwise the defaults
      // now and the reader's remembered style as soon as the file answers. The
      // read is a user-level file rather than WebView storage, so it cannot be
      // waited for while the dialog opens.
      if (activeConfig) {
        untouched.current = false
        setDraft(draftFromConfig(activeConfig, pageCount))
        return
      }

      untouched.current = true
      setDraft(draftFromPreferences(defaultPageNumbersPreferences, pageCount))
      void loadPageNumbersPreferences().then((stored) => {
        if (stored && untouched.current) {
          setDraft(draftFromPreferences(stored, pageCount))
        }
      })
    },
    [activeConfig, pageCount],
  )

  // Opening from the toolbar is just the open half of `onOpenChange`.
  const openDialog = useCallback(() => onOpenChange(true), [onOpenChange])

  // One parse feeds both the apply and the error the dialog shows, so the
  // config applied is always the one the reader saw validated.
  const parsed = useMemo(
    () => parsePageNumbersDraft(draft, pageCount),
    [draft, pageCount],
  )

  const apply = useCallback(async () => {
    if (!parsed.config || pageCount < 1) {
      return
    }

    setIsApplying(true)
    try {
      // Only a change the document accepted is worth remembering as a style,
      // and only one is worth dismissing the dialog over.
      if (await onSet(parsed.config, pageCount)) {
        void storePageNumbersPreferences(parsed.config)
        setOpen(false)
      }
    } finally {
      setIsApplying(false)
    }
  }, [onSet, pageCount, parsed])

  const remove = useCallback(async () => {
    if (!activeConfig || pageCount < 1) {
      return
    }

    setIsApplying(true)
    try {
      if (await onSet(null, pageCount)) {
        setOpen(false)
      }
    } finally {
      setIsApplying(false)
    }
  }, [activeConfig, onSet, pageCount])

  // A draft belongs to one open document, so a switch closes the dialog; the
  // next open re-derives the draft, leaving nothing to reset here.
  useEffect(() => {
    setOpen(false)
    setIsApplying(false)
  }, [documentId])

  return {
    apply,
    draft,
    hasPageNumbers: activeConfig !== null,
    isApplying,
    onOpenChange,
    open,
    openDialog,
    remove,
    setDraft: changeDraft,
    validationError: parsed.error,
  }
}
