import { useCallback, useEffect, useMemo, useState } from "react"

import {
  draftFromConfig,
  draftFromPreferences,
  defaultPageNumbersPreferences,
  parsePageNumbersDraft,
  readStoredPageNumbersPreferences,
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

function freshDraft(activeConfig: PageNumbersConfig | null): PageNumbersDraft {
  if (activeConfig) {
    return draftFromConfig(activeConfig)
  }

  return draftFromPreferences(
    readStoredPageNumbersPreferences() ?? defaultPageNumbersPreferences,
  )
}

/** Owns the dialog's disposable draft; only apply and remove touch the PDF. */
export function usePageNumbers({
  activeConfig,
  documentId,
  onSet,
  pageCount,
}: UsePageNumbersOptions) {
  const [draft, setDraft] = useState<PageNumbersDraft>(() =>
    freshDraft(activeConfig),
  )
  const [isApplying, setIsApplying] = useState(false)
  const [open, setOpen] = useState(false)

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setDraft(freshDraft(activeConfig))
      }
      setOpen(nextOpen)
    },
    [activeConfig],
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
        storePageNumbersPreferences(parsed.config)
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
    setDraft,
    validationError: parsed.error,
  }
}
