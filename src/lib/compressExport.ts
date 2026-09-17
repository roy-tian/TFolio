/** Mirrors `CompressionOptions` in `src-tauri/src/pdfium/compress.rs`, tagged
    so one variant carries the rasterized copy's levels. */
export type CompressionOptions =
  | { mode: "lossless" }
  | { mode: "rasterized"; dpi: number; quality: number }

/** Mirrors `CompressionEstimate`; `exact` says whether the figure is the
    pipeline's own output or an extrapolation across sampled pages. The
    invoke resolves to null when the run was stopped. */
export type CompressionEstimate = {
  originalBytes: number
  estimatedBytes: number
  exact: boolean
}

export type CompressedExportRequest = {
  options: CompressionOptions
  suggestedName: string
  filterLabel: string
}

// The bounds the engine enforces on its own; the sliders stay inside them.
export const MIN_RASTER_DPI = 72
export const MAX_RASTER_DPI = 300
export const MIN_JPEG_QUALITY = 10
export const MAX_JPEG_QUALITY = 100

/** The named densities the rasterized mode offers, inside those bounds. */
export const RASTER_DPI_CHOICES = [75, 150, 300] as const
