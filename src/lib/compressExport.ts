/** Mirrors `CompressionOptions` in `src-tauri/engine/src/pdfium/compress.rs`:
    image quality percentage (`0..=100`). `100` leaves images untouched and
    compresses PDF structure alone. */
export type CompressionOptions = {
  imageQuality: number
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

export const MIN_IMAGE_QUALITY = 0
export const MAX_IMAGE_QUALITY = 100
export const IMAGE_QUALITY_STEP = 5
export const DEFAULT_IMAGE_QUALITY = 60
