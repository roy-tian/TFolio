export type PdfProgress = {
  completed: number
  total: number
}

export type PdfOwnedLayer = "pageNumbers" | "watermark"

export type PdfOwnedLayerProgressHandler = (
  layer: PdfOwnedLayer,
  progress: PdfProgress,
) => void

/** A bounded whole percentage for progress received across IPC. */
export function progressPercent({ completed, total }: PdfProgress) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return 0
  }

  return Math.round(Math.min(1, Math.max(0, completed / total)) * 100)
}

/** How a long owned-layer operation ended, as the dialog that started it needs
    to hear it: only "applied" is worth remembering as a style, and only
    "failed" is worth keeping the dialog open over. */
export type PdfLayerOutcome = "applied" | "cancelled" | "failed"

/**
 * Thrown by the work of an operation the reader stopped.
 *
 * An error rather than a return value because it travels the path a refusal
 * travels: the shared queue leaves the history alone whenever work throws,
 * which is exactly what a document rolled back to its previous bytes needs.
 */
export class PdfOperationCancelled extends Error {
  constructor() {
    super("the operation was stopped")
    this.name = "PdfOperationCancelled"
  }
}
