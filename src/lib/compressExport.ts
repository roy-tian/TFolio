/** Mirrors `CompressionOptions` in `src-tauri/src/pdfium/compress.rs`: the
    resolution images are resampled toward, in pixels per inch of their drawn
    size. `null` leaves images untouched. */
export type CompressionOptions = {
  imageDpi: number | null
}

/** Mirrors `CompressionEstimate`; `estimatedBytes` is exactly what the export
    writes, `originalBytes` the opened file until an edit. The invoke resolves
    to null when the run was stopped. */
export type CompressionEstimate = {
  originalBytes: number
  estimatedBytes: number
}

export type CompressedExportRequest = {
  options: CompressionOptions
  suggestedName: string
  filterLabel: string
}

/** The dialog's choices, inside the 72–300 dpi the engine enforces on its own. */
export const IMAGE_QUALITY_LEVELS = [
  { level: "original", imageDpi: null },
  { level: "high", imageDpi: 220 },
  { level: "medium", imageDpi: 150 },
  { level: "low", imageDpi: 96 },
] as const

export type ImageQualityLevel = (typeof IMAGE_QUALITY_LEVELS)[number]["level"]

export const DEFAULT_IMAGE_QUALITY: ImageQualityLevel = "medium"
