export type ImageFormat = "jpg" | "png"

/** Mirrors `ArchiveOptions` in `src-tauri/engine/src/pdfium/archive.rs`, tagged so
    only the images variant carries the density and page selection. */
export type ArchiveOptions =
  | { format: "images"; imageFormat: ImageFormat; dpi: number; pages: number[] }
  | { format: "bookmarks" }
  | { format: "pages" }

export type ArchiveExportRequest = {
  options: ArchiveOptions
  suggestedName: string
  filterLabel: string
}

// The bounds the engine enforces on its own; the picker stays inside them.
export const MIN_IMAGE_DPI = 72
export const MAX_IMAGE_DPI = 600

export type ImageResolution = "high" | "medium" | "low"

/** The named resolutions the dialog offers; each maps to a density without
    exposing dpi jargon in the interface. */
export const IMAGE_RESOLUTION_CHOICES = [
  { key: "high", dpi: 300 },
  { key: "medium", dpi: 150 },
  { key: "low", dpi: 75 },
] as const

export const DEFAULT_IMAGE_RESOLUTION: ImageResolution = "medium"
