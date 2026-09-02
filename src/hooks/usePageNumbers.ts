import { useCallback, useEffect, useMemo, useState } from "react"

import {
  draftFromConfig,
  draftFromPreferences,
  parsePageNumbersDraft,
  storedPageNumbersPreferences,
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

/**
 * What the dialog opens on: the document's own numbers where it has them, and
 * otherwise the style this reader last applied. Both are in hand before the
 * dialog paints — the settings are loaded once, at startup.
 */
function openingDraft(
  activeConfig: PageNumbersConfig | null,
  pageCount: number,
): PageNumbersDraft {
  return activeConfig
    ? draftFromConfig(activeConfig, pageCount)
    : draftFromPreferences(storedPageNumbersPreferences(), pageCount)
}

/** Owns the dialog's disposable draft; only apply and remove touch the PDF. */
export function usePageNumbers({
  activeConfig,
  documentId,
  onSet,
  pageCount,
}: UsePageNumbersOptions) {
  const [draft, setDraft] = useState<PageNumbersDraft>(() =>
    openingDraft(activeConfig, pageCount),
  )
  const [isApplying, setIsApplying] = useState(false)
  const [open, setOpen] = useState(false)

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)

      if (nextOpen) {
        setDraft(openingDraft(activeConfig, pageCount))
      }
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
