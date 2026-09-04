import { useCallback, useEffect, useRef, useState } from "react"

import type { PdfLayerOutcome, PdfProgress } from "@/lib/progress"
import {
  defaultWatermarkConfig,
  readStoredWatermarkConfig,
  storeWatermarkConfig,
  validateWatermarkConfig,
  type WatermarkConfig,
} from "@/lib/watermark"

type UseWatermarkOptions = {
  activeConfig: WatermarkConfig | null
  /** The mark a reader who has never applied one starts from, translated. */
  defaultText: string
  documentId?: number
  /** Stops the run in flight, which rolls the document back. Resolves to
      whether the backend had one listed to stop. */
  onCancel: () => Promise<boolean>
  /** Resolves to how the change ended. */
  onSet: (
    config: WatermarkConfig | null,
    pageCount: number,
    onProgress: (progress: PdfProgress) => void,
  ) => Promise<PdfLayerOutcome>
  pageCount: number
}

function freshConfig(activeConfig: WatermarkConfig | null, defaultText: string) {
  if (activeConfig) {
    return { ...activeConfig }
  }

  return readStoredWatermarkConfig() ?? defaultWatermarkConfig(defaultText)
}

/** Owns the dialog's disposable draft; only apply and remove touch the PDF. */
export function useWatermark({
  activeConfig,
  defaultText,
  documentId,
  onCancel,
  onSet,
  pageCount,
}: UseWatermarkOptions) {
  const [draft, setDraft] = useState<WatermarkConfig>(() =>
    freshConfig(activeConfig, defaultText),
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

  /** The run's own progress, and — see `usePageNumbers` — the place a stop the
      backend was not yet listening for is asked again. */
  const trackProgress = useCallback(
    (next: PdfProgress) => {
      setProgress(next)

      if (unanswered.current) {
        void ask()
      }
    },
    [ask],
  )

  const openDialog = useCallback(() => {
    setDraft(freshConfig(activeConfig, defaultText))
    setOpen(true)
  }, [activeConfig, defaultText])

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      // Keep the determinate feedback in view until the document transaction
      // settles. The successful path closes itself below.
      if (!nextOpen && isApplying) {
        return
      }

      if (nextOpen) {
        setDraft(freshConfig(activeConfig, defaultText))
      }
      setOpen(nextOpen)
    },
    [activeConfig, defaultText, isApplying],
  )

  const apply = useCallback(async () => {
    // Trimmed the way the backend trims it, so a stray space does not read as
    // a change the page never took.
    const config = { ...draft, text: draft.text.trim() }

    if (validateWatermarkConfig(config) || pageCount < 1) {
      return
    }

    unanswered.current = false
    setProgress({ completed: 0, total: pageCount * 2 })
    setIsApplying(true)
    setIsStopping(false)
    try {
      // Only a change the document accepted is worth remembering as this
      // reader's watermark. A stop leaves the dialog too — the reader asked to
      // be out of it — but takes nothing with it, the document being back as
      // it was.
      const outcome = await onSet(config, pageCount, trackProgress)

      if (outcome === "applied") {
        storeWatermarkConfig(config)
      }
      if (outcome !== "failed") {
        setOpen(false)
      }
    } finally {
      setProgress(null)
      setIsApplying(false)
      setIsStopping(false)
    }
  }, [draft, onSet, pageCount, trackProgress])

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

  /** The reader's way out of a long run — see `usePageNumbers`, which stops
      its own the same way. */
  const stop = useCallback(() => {
    if (!isApplying) {
      return
    }

    unanswered.current = true
    setIsStopping(true)
    void ask()
  }, [ask, isApplying])

  // A draft belongs to one open document. Closing or replacing it must not
  // leave an old document's text waiting in a dialog for its successor.
  useEffect(() => {
    unanswered.current = false
    setOpen(false)
    setIsApplying(false)
    setIsStopping(false)
    setProgress(null)
    // Deliberately not keyed on `defaultText`: a language change is not a
    // document change, and the draft is rebuilt when the dialog next opens.
    setDraft(freshConfig(null, defaultText))
  }, [documentId])

  return {
    apply,
    draft,
    hasWatermark: activeConfig !== null,
    isApplying,
    isStopping,
    onOpenChange,
    open,
    openDialog,
    progress,
    remove,
    setDraft,
    stop,
    validationError: validateWatermarkConfig(draft),
  }
}
