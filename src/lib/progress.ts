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
