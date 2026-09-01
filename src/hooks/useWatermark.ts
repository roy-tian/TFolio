import { useCallback, useEffect, useState } from "react"

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
  /** Resolves to whether the change reached the document. */
  onSet: (config: WatermarkConfig | null, pageCount: number) => Promise<boolean>
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
  onSet,
  pageCount,
}: UseWatermarkOptions) {
  const [draft, setDraft] = useState<WatermarkConfig>(() =>
    freshConfig(activeConfig, defaultText),
  )
  const [isApplying, setIsApplying] = useState(false)
  const [open, setOpen] = useState(false)

  const openDialog = useCallback(() => {
    setDraft(freshConfig(activeConfig, defaultText))
    setOpen(true)
  }, [activeConfig, defaultText])

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setDraft(freshConfig(activeConfig, defaultText))
      }
      setOpen(nextOpen)
    },
    [activeConfig, defaultText],
  )

  const apply = useCallback(async () => {
    // Trimmed the way the backend trims it, so a stray space does not read as
    // a change the page never took.
    const config = { ...draft, text: draft.text.trim() }

    if (validateWatermarkConfig(config) || pageCount < 1) {
      return
    }

    setIsApplying(true)
    try {
      // Only a change the document accepted is worth remembering as this
      // reader's watermark, and only one is worth dismissing the dialog over.
      if (await onSet(config, pageCount)) {
        storeWatermarkConfig(config)
        setOpen(false)
      }
    } finally {
      setIsApplying(false)
    }
  }, [draft, onSet, pageCount])

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

  // A draft belongs to one open document. Closing or replacing it must not
  // leave an old document's text waiting in a dialog for its successor.
  useEffect(() => {
    setOpen(false)
    setIsApplying(false)
    // Deliberately not keyed on `defaultText`: a language change is not a
    // document change, and the draft is rebuilt when the dialog next opens.
    setDraft(freshConfig(null, defaultText))
  }, [documentId])

  return {
    apply,
    draft,
    hasWatermark: activeConfig !== null,
    isApplying,
    onOpenChange,
    open,
    openDialog,
    remove,
    setDraft,
    validationError: validateWatermarkConfig(draft),
  }
}
