export type PdfProgress = {
  completed: number
  total: number
}

export type PdfOwnedLayer = "pageNumbers" | "watermark"

export type PdfOwnedLayerProgressHandler = (
  layer: PdfOwnedLayer,
  progress: PdfProgress,
) => void

export function progressPercent({ completed, total }: PdfProgress) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return 0
  }

  return Math.round(Math.min(1, Math.max(0, completed / total)) * 100)
}

/** Only "applied" is worth remembering as a style; only "failed" is worth
    keeping the dialog open over. */
export type PdfLayerOutcome = "applied" | "cancelled" | "failed"

/**
 * An error, not a return value: it travels the path a refusal travels, and the
 * shared queue leaves history alone whenever work throws — what a rollback needs.
 */
export class PdfOperationCancelled extends Error {
  constructor() {
    super("the operation was stopped")
    this.name = "PdfOperationCancelled"
  }
}
