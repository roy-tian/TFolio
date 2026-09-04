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
  /** Resolves to how the change ended. */
  onSet: (
    config: PageNumbersConfig | null,
    pageCount: number,
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<PdfLayerOutcome>
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
   * The run's own progress, and the place a stop it missed is asked again.
   *
   * A stop is reachable the moment the dialog paints its progress, which is
   * before the command behind it has listed itself to be stopped — and an ask
   * that arrives then reaches nothing. Every event here comes from a run that
   * *is* listed, so repeating it there costs the reader a page at most.
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

    unanswered.current = false
    setProgress({ completed: 0, total: pageCount * 2 })
    setIsApplying(true)
    setIsStopping(false)
    try {
      // Only a change the document accepted is worth remembering as a style.
      // A stop leaves the dialog too — the reader asked to be out of it — but
      // takes nothing with it, since the document is back as it was.
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
   * The reader's way out of a long run: the backend stops between pages and
   * rolls the document back, and the apply above then closes the dialog.
   *
   * Nothing here waits for that — the ask is what matters, and it is the one
   * message that does not queue behind the work it is stopping. It is repeated
   * from the run's progress until the backend answers that it landed.
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
