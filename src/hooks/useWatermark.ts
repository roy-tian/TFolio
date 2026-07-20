import { useCallback, useEffect, useState } from "react"

import {
  defaultWatermarkConfig,
  defaultWatermarkPreferences,
  normalizeWatermarkRotation,
  readStoredWatermarkPreferences,
  storeWatermarkPreferences,
  validateWatermarkConfig,
  type WatermarkConfig,
} from "@/lib/watermark"

type UseWatermarkOptions = {
  activeConfig: WatermarkConfig | null
  documentId?: number
  /** Resolves to whether the change reached the document. */
  onSet: (config: WatermarkConfig | null, pageCount: number) => Promise<boolean>
  pageCount: number
}

function freshConfig(activeConfig: WatermarkConfig | null) {
  if (activeConfig) {
    return { ...activeConfig }
  }

  return defaultWatermarkConfig(
    readStoredWatermarkPreferences() ?? defaultWatermarkPreferences,
  )
}

/** Owns the dialog's disposable draft; only apply and remove touch the PDF. */
export function useWatermark({
  activeConfig,
  documentId,
  onSet,
  pageCount,
}: UseWatermarkOptions) {
  const [draft, setDraft] = useState<WatermarkConfig>(() =>
    freshConfig(activeConfig),
  )
  const [isApplying, setIsApplying] = useState(false)
  const [open, setOpen] = useState(false)

  const openDialog = useCallback(() => {
    setDraft(freshConfig(activeConfig))
    setOpen(true)
  }, [activeConfig])

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setDraft(freshConfig(activeConfig))
      }
      setOpen(nextOpen)
    },
    [activeConfig],
  )

  const apply = useCallback(async () => {
    // Canonicalised the way the backend will canonicalise it, so the two ends
    // of the angle control do not read as a change the page never took.
    const config = {
      ...draft,
      rotation: normalizeWatermarkRotation(draft.rotation),
      text: draft.text.trim(),
    }

    if (validateWatermarkConfig(config) || pageCount < 1) {
      return
    }

    setIsApplying(true)
    try {
      // Only a change the document accepted is worth remembering as a style,
      // and only one is worth dismissing the dialog over.
      if (await onSet(config, pageCount)) {
        storeWatermarkPreferences(config)
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
    setDraft(freshConfig(null))
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
