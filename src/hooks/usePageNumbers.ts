import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { PdfLayerOutcome, PdfProgress } from "@/lib/progress"
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
  /** Stops the run in flight, which rolls the document back. Resolves to
      whether the backend had one listed to stop. */
  onCancel: () => Promise<boolean>
  onSet: (
    config: PageNumbersConfig | null,
    pageCount: number,
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<PdfLayerOutcome>
  pageCount: number
}

/**
 * The document's own numbers, else the style last applied. Both are in hand
 * before the dialog paints — settings are read once, at startup.
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
  onCancel,
  onSet,
  pageCount,
}: UsePageNumbersOptions) {
  const [draft, setDraft] = useState<PageNumbersDraft>(() =>
    openingDraft(activeConfig, pageCount),
  )
  const [isApplying, setIsApplying] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const [open, setOpen] = useState(false)
  // A stop the backend had nothing to answer with, still owed to the reader.
  const unanswered = useRef(false)

  const ask = useCallback(async () => {
    if (await onCancel()) {
      unanswered.current = false
    }
  }, [onCancel])

  /**
   * A stop pressed before the command lists itself reaches nothing, so the ask
   * is repeated here, where every event comes from a run that *is* listed.
   */
  const trackProgress = useCallback(
    (next: PdfProgress) => {
      setProgress(next)

      if (unanswered.current) {
        void ask()
      }
    },
    [ask],
  )

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Keep the determinate feedback in view until the document transaction
      // settles. The successful path closes itself below.
      if (!nextOpen && isApplying) {
        return
      }

      setOpen(nextOpen)

      if (nextOpen) {
        setDraft(openingDraft(activeConfig, pageCount))
      }
    },
    [activeConfig, isApplying, pageCount],
  )

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

    unanswered.current = false
    setProgress({ completed: 0, total: pageCount * 2 })
    setIsApplying(true)
    setIsStopping(false)
    try {
      // Only an accepted change is worth remembering as a style. A stop also
      // leaves the dialog, but takes nothing: the document is back as it was.
      const outcome = await onSet(parsed.config, pageCount, trackProgress)

      if (outcome === "applied") {
        storePageNumbersPreferences(parsed.config)
      }
      if (outcome !== "failed") {
        setOpen(false)
      }
    } finally {
      setProgress(null)
      setIsApplying(false)
      setIsStopping(false)
    }
  }, [onSet, pageCount, parsed, trackProgress])

  const remove = useCallback(async () => {
    if (!activeConfig || pageCount < 1) {
      return
    }

    unanswered.current = false
    setProgress({ completed: 0, total: pageCount * 2 })
    setIsApplying(true)
    setIsStopping(false)
    try {
      if ((await onSet(null, pageCount, trackProgress)) !== "failed") {
        setOpen(false)
      }
    } finally {
      setProgress(null)
      setIsApplying(false)
      setIsStopping(false)
    }
  }, [activeConfig, onSet, pageCount, trackProgress])

  /**
   * The ask is the one message that does not queue behind the work it stops;
   * it is repeated from the run's progress until the backend answers.
   */
  const stop = useCallback(() => {
    if (!isApplying) {
      return
    }

    unanswered.current = true
    setIsStopping(true)
    void ask()
  }, [ask, isApplying])

  // A draft belongs to one open document, so a switch closes the dialog; the
  // next open re-derives the draft, leaving nothing to reset here.
  useEffect(() => {
    unanswered.current = false
    setOpen(false)
    setIsApplying(false)
    setIsStopping(false)
    setProgress(null)
  }, [documentId])

  return {
    apply,
    draft,
    hasPageNumbers: activeConfig !== null,
    isApplying,
    isStopping,
    onOpenChange,
    open,
    openDialog,
    progress,
    remove,
    setDraft,
    stop,
    validationError: parsed.error,
  }
}
